// Parspec PM events: subscribe, verify, callback. No dependencies (Node 18+).
'use strict';

const crypto = require('crypto');

const ENVIRONMENTS = {
  production: 'https://platform.parspec.io/platform-api/api/v1/',
  sandbox: 'https://platform-sandbox.parspec.io/platform-api/api/v1/',
  preprod: 'https://uat-platform.parspec.io/platform-api/api/v1/'
};
const DEFAULT_CALLBACK = 'integrations/events/callback';

class SignatureError extends Error {}
class ParspecApiError extends Error {
  constructor(message, status, body) { super(message); this.status = status; this.body = body; }
}

// True when X-Signature (base64 RSA-SHA256) verifies against the RAW request bytes.
// Re-serialized JSON will not verify; pass the body exactly as received.
function verify(rawBody, signature, publicKeyPem) {
  if (!signature) return false;
  try {
    return crypto.verify('RSA-SHA256', Buffer.from(rawBody), publicKeyPem, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

const header = (headers, name) => {
  const key = Object.keys(headers || {}).find(k => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : headers[key];
};

// Verify then parse. Throws SignatureError on a bad or missing signature.
// Deduplicate on the returned transactionId: PM can deliver the same event more than once.
function parseEvent(rawBody, headers, publicKeyPem) {
  if (!verify(rawBody, header(headers, 'x-signature'), publicKeyPem)) throw new SignatureError('X-Signature did not verify');
  const event = JSON.parse(Buffer.from(rawBody).toString('utf8'));
  return { event, transactionId: event.eventTransactionID, idempotencyKey: header(headers, 'idempotency-key') };
}

function createClient({ apiKey, environment = 'production', baseUrl = ENVIRONMENTS[environment], fetch: fetchImpl = fetch }) {
  if (!apiKey) throw new Error('apiKey is required');
  if (!baseUrl) throw new Error(`unknown environment: ${environment}`);
  const base = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';

  async function call(method, pathOrUrl, body) {
    const url = /^https?:\/\//.test(pathOrUrl) ? pathOrUrl : base + pathOrUrl.replace(/^\/+/, '');
    const res = await fetchImpl(url, {
      method,
      headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
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
    if (res.status !== 200 || !res.body || !res.body.publicKey) {
      throw new ParspecApiError(`subscribe ${eventType} v${version} failed: ${res.status} ${res.text.slice(0, 200)}`, res.status, res.body);
    }
    return { publicKey: res.body.publicKey, replaced };
  }

  // One callback per event. `fields` carries what PM expects back (orderId, projectErpId, ...).
  async function sendCallback(event, status, fields) {
    const res = await call('POST', event.callback_url || DEFAULT_CALLBACK, { EventTransactionID: event.eventTransactionID, EventStatus: status, ...fields });
    if (res.status < 200 || res.status >= 300) throw new ParspecApiError(`callback failed: ${res.status} ${res.text.slice(0, 200)}`, res.status, res.body);
    return res.body;
  }
  const callback = (event, fields = {}) => sendCallback(event, 'success', fields);
  // The message is shown to the PM user (e.g. a failed credit check).
  const fail = (event, message, fields = {}) => sendCallback(event, 'error', { errorMessage: message, ...fields });

  return { subscribe, unsubscribe, callback, fail };
}

module.exports = { createClient, verify, parseEvent, SignatureError, ParspecApiError, ENVIRONMENTS };
