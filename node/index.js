// Parspec PM events: subscribe, verify, callback. No dependencies (Node 18+).
'use strict';

const crypto = require('crypto');

const ENVIRONMENTS = Object.freeze({
  production: 'https://platform.parspec.io/platform-api/api/v1/',
  sandbox: 'https://platform-sandbox.parspec.io/platform-api/api/v1/',
  preprod: 'https://uat-platform.parspec.io/platform-api/api/v1/',
  uat: 'https://uat-platform.parspec.io/platform-api/api/v1/',
  local: 'http://127.0.0.1:4800/platform-api/api/v1/'   // the playground: node harness/playground.js
});
const MAX_BODY = 5 << 20;
const DEFAULT_CALLBACK = 'integrations/events/callback';

// The signature did not verify: the request did not come from PM, or the key is stale.
class SignatureError extends Error {}
// The signature verified, but the body is not a PM event envelope.
class EventError extends Error {}
// A PM API call failed. status is the HTTP status, or 0 when there was no response
// (network failure, timeout) or the request was refused before sending.
class ParspecApiError extends Error {
  constructor(message, status, body) { super(message); this.status = status; this.body = body; }
}

// True when X-Signature (base64 RSA-SHA256) verifies against the RAW request bytes, false otherwise.
// Never throws: a bad signature, a bad key and a non-RSA key all return false.
// Re-serialized JSON will not verify; pass the body exactly as received.
function verify(rawBody, signature, publicKeyPem) {
  if (!signature || typeof signature !== 'string') return false;
  try {
    const key = crypto.createPublicKey(publicKeyPem);
    if (key.asymmetricKeyType !== 'rsa') return false;
    return crypto.verify('RSA-SHA256', Buffer.from(rawBody), key, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

const header = (headers, name) => {
  const key = Object.keys(headers || {}).find(k => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : headers[key];
};

// Verify then parse. Throws SignatureError on a bad or missing signature, EventError when a signed
// body is not a PM event. Deduplicate on the returned transactionId: PM can deliver an event twice.
function parseEvent(rawBody, headers, publicKeyPem) {
  if (!verify(rawBody, header(headers, 'x-signature'), publicKeyPem)) throw new SignatureError('X-Signature did not verify');
  let event;
  try { event = JSON.parse(Buffer.from(rawBody).toString('utf8')); } catch (e) { throw new EventError(`body is not JSON: ${e.message}`); }
  if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.eventTransactionID !== 'string' || !event.eventTransactionID) {
    throw new EventError('body is not a PM event: expected an object with an eventTransactionID');
  }
  return { event, transactionId: event.eventTransactionID, idempotencyKey: header(headers, 'idempotency-key') };
}

function createClient({ apiKey, environment = 'production', baseUrl = ENVIRONMENTS[environment], timeoutMs = 30000, fetch: fetchImpl = fetch }) {
  if (!apiKey) throw new Error('apiKey is required');
  if (!baseUrl) throw new Error(`unknown environment: ${environment}`);
  const base = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
  const origin = new URL(base).origin;

  // Relative paths resolve against the base. An absolute URL is allowed only on the base's origin:
  // the API key goes with every request, so a host named in a payload must never receive it.
  function resolve(pathOrUrl) {
    if (!/^https?:\/\//i.test(pathOrUrl)) return base + pathOrUrl.replace(/^\/+/, '');
    let url;
    try { url = new URL(pathOrUrl); } catch { throw new ParspecApiError(`invalid URL ${pathOrUrl}`, 0); }
    if (url.origin !== origin) throw new ParspecApiError(`refusing to send the API key to ${url.origin} (only ${origin})`, 0);
    return url.href;
  }

  async function call(method, pathOrUrl, body) {
    const url = resolve(pathOrUrl);
    let res;
    try {
      res = await fetchImpl(url, {
        method,
        headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (e) {
      throw new ParspecApiError(`${method} ${url} failed: ${e.message}`, 0);
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body: keep the text */ }
    return { status: res.status, body: json, text };
  }

  // Omit version to clear both 1 and 2 (only one can be active, and you may not know which).
  async function unsubscribe(eventType, version) {
    const versions = version ? [version] : [1, 2];
    const out = [];
    for (const v of versions) out.push({ version: v, status: (await call('DELETE', 'integrations/events/unsubscribe', { event_type: eventType, event_version: v })).status });
    return out;
  }

  // Subscribe is not an upsert, so both versions are cleared first. Returns the NEW publicKey:
  // every subscribe mints one, and events are signed with it from now on — store it and
  // reload it wherever you verify.
  async function subscribe(eventType, version, webhookUrl) {
    await unsubscribe(eventType);
    const put = () => call('PUT', 'integrations/events/subscribe', { event_type: eventType, event_version: version, webhook_url: webhookUrl });
    let res = await put();
    // An org can hold more than one subscription for the same event (another deployment's);
    // each DELETE removes one. Clear the version the error names and retry, a bounded number of times.
    let replaced = 0;
    while (res.status === 400 && /already exists/i.test(res.text) && replaced < 3) {
      const named = /version\s+'?(\d+)'?/i.exec(res.text);
      const del = await call('DELETE', 'integrations/events/unsubscribe', { event_type: eventType, event_version: named ? Number(named[1]) : version });
      if (del.status !== 200) break;
      replaced++;
      res = await put();
    }
    const key = res.body && typeof res.body === 'object' && !Array.isArray(res.body) ? res.body.publicKey : undefined;
    if (res.status !== 200 || typeof key !== 'string' || !key) {
      throw new ParspecApiError(`subscribe ${eventType} v${version} failed: ${res.status} ${res.text.slice(0, 200)}`, res.status, res.body);
    }
    return { publicKey: key, replaced };
  }

  // One callback per event. `fields` carries what PM expects back (orderId, projectErpId, ...).
  async function sendCallback(event, status, fields) {
    // The SDK's two fields last, so a caller's fields cannot forge them.
    const res = await call('POST', event.callback_url || DEFAULT_CALLBACK, { ...fields, EventTransactionID: event.eventTransactionID, EventStatus: status });
    if (res.status < 200 || res.status >= 300) throw new ParspecApiError(`callback failed: ${res.status} ${res.text.slice(0, 200)}`, res.status, res.body);
    return res.body;
  }
  const callback = (event, fields = {}) => sendCallback(event, 'success', fields);
  // The message is shown to the PM user (e.g. a failed credit check).
  const fail = (event, message, fields = {}) => sendCallback(event, 'error', { ...fields, errorMessage: message });

  return { subscribe, unsubscribe, callback, fail };
}

// ---- Receiver: register a function per event type; the SDK verifies, routes, dedupes and calls back ----
//
// Storage is yours. Two small interfaces, sync or async:
//   keys:         get() -> { eventType: publicKeyPem }   and, optionally, set(eventType, publicKeyPem)
//                 (env vars, a keychain, a secrets manager, a file; omit set() when keys are read-only)
//   transactions: claim(txid) -> boolean (atomically: false when done or in progress), done(txid), release(txid)
//                 (a database row or Redis SET NX in production, so it survives restarts and spans servers)
// memoryKeys() and memoryTransactions() are the in-process versions, for development.

function memoryKeys(initial = {}) {
  const keys = { ...initial };
  return { get: () => ({ ...keys }), set: (eventType, publicKey) => { keys[eventType] = publicKey; } };
}

// leaseMs: a claim older than this counts as abandoned (the worker died), so a redelivery can take it.
function memoryTransactions({ leaseMs = 15 * 60 * 1000 } = {}) {
  const processing = new Map();   // txid -> claimed at
  const done = new Set();
  return {
    claim(txid) {
      if (done.has(txid)) return false;
      const at = processing.get(txid);
      if (at !== undefined && Date.now() - at < leaseMs) return false;
      processing.set(txid, Date.now());
      return true;
    },
    done(txid) { processing.delete(txid); done.add(txid); },
    release(txid) { processing.delete(txid); }
  };
}

function createReceiver({ client, keys = memoryKeys(), transactions = memoryTransactions(), onError = () => {} }) {
  if (!client) throw new Error('client is required');
  const handlers = new Map();   // eventType -> { handler, version }

  // handler(event, ctx) returns the callback fields (or nothing, for a plain acknowledgement).
  // Throwing sends an error callback with the message, which PM shows to the user.
  function on(eventType, handler, { version = 1 } = {}) {
    handlers.set(eventType, { handler, version });
    return api;
  }

  // Subscribes every registered event to webhookUrl. Each subscribe mints a new key: it goes to
  // keys.set() when the store has one; the keys are also returned, for stores you manage yourself.
  async function subscribe(webhookUrl) {
    const minted = {};
    for (const [eventType, { version }] of handlers) {
      minted[eventType] = (await client.subscribe(eventType, version, webhookUrl)).publicKey;
      if (keys.set) await keys.set(eventType, minted[eventType]);
    }
    return minted;
  }

  // Phase 1, fast: verify, parse, claim. Answer PM with `status` right away, then run process().
  async function accept(rawBody, headers) {
    const noop = async () => {};
    const stored = (await keys.get()) || {};
    const match = Object.entries(stored).find(([, key]) => verify(rawBody, header(headers, 'x-signature'), key));
    if (!match) return { status: 401, process: noop };
    const [eventType, key] = match;
    let parsed;
    try { parsed = parseEvent(rawBody, headers, key); } catch (e) { return { status: 400, process: noop, error: e }; }
    const { event, transactionId, idempotencyKey } = parsed;
    if (!(await transactions.claim(transactionId))) return { status: 200, eventType, transactionId, duplicate: true, process: noop };
    const ctx = { eventType, transactionId, idempotencyKey };
    return { status: 200, eventType, transactionId, process: () => run(event, ctx) };
  }

  // Phase 2: the handler, one callback, and the claim settled: done, or released so a redelivery retries.
  async function run(event, ctx) {
    const registered = handlers.get(ctx.eventType);
    let fields, failure;
    try {
      fields = registered ? await registered.handler(event, ctx) : undefined;
    } catch (e) { failure = e; }
    try {
      if (failure) await client.fail(event, failure.message || String(failure));
      else await client.callback(event, fields || {});
    } catch (e) {
      await transactions.release(ctx.transactionId);
      onError(e, ctx);
      return;
    }
    if (failure) { await transactions.release(ctx.transactionId); onError(failure, ctx); }
    else await transactions.done(ctx.transactionId);
  }

  // Both phases in one call, when your framework can answer after the work is done.
  async function handle(rawBody, headers) {
    const r = await accept(rawBody, headers);
    await r.process();
    return r.status;
  }

  // A standard (req, res) handler: reads the raw body, answers PM, then runs the event's function.
  //   http.createServer(receiver.handler())            or   app.post('/parspec/webhook', receiver.handler())
  // In Express, mount it before any JSON body parser, or with express.raw(): a parsed body cannot be verified.
  function handler() {
    return (req, res) => {
      if (req.method !== 'POST') return void res.writeHead(405, { Allow: 'POST' }).end();
      const done = async raw => {
        try {
          const r = await accept(raw, req.headers);
          res.writeHead(r.status).end();
          await r.process();
        } catch (e) {
          if (!res.headersSent) res.writeHead(500).end();
          onError(e, {});
        }
      };
      if (Buffer.isBuffer(req.body) || typeof req.body === 'string') return void done(Buffer.from(req.body));
      if (req.body !== undefined || req.readableEnded) {
        res.writeHead(500).end();
        return void onError(new Error('the request body was already parsed: mount the handler before any JSON body parser, or use express.raw()'), {});
      }
      const chunks = [];
      let size = 0;
      req.on('data', c => {
        size += c.length;
        if (size > MAX_BODY) { res.writeHead(413, { Connection: 'close' }).end(); req.destroy(); } else chunks.push(c);
      });
      req.on('end', () => { if (size <= MAX_BODY) done(Buffer.concat(chunks)); });
    };
  }

  const api = { on, subscribe, accept, handle, handler };
  return api;
}

module.exports = { createClient, createReceiver, memoryKeys, memoryTransactions, verify, parseEvent, SignatureError, EventError, ParspecApiError, ENVIRONMENTS };
