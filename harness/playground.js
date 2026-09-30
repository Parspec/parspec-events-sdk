#!/usr/bin/env node
// PM playground: a local stand-in for PM's events API with a web page for sending mocked events.
//
//   node harness/playground.js [--port 4800] [--mocks <dir>]...
//
// Point your receiver's SDK at http://localhost:4800/platform-api/api/v1/ instead of PM, subscribe as
// usual (or from the page), then pick a mock and send it. Deliveries are signed with the subscription's
// key, exactly as PM signs them; callbacks your receiver sends back show up on the page.
//
// Mocks: fixtures/samples/ plus every --mocks folder (default ./mocks if it exists), re-read on each
// refresh, so dropping a JSON file in the folder is enough. Accepted files: the sample format
// {eventType, version, delivery, callback}, or a raw PM envelope {eventTransactionID, data, ...} whose
// event type comes from an `eventType` field or the file name (tandemOrder_publishToErp-1234.json or
// tandemOrder.publishToErp.json).
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SAMPLES = path.join(ROOT, 'fixtures/samples');
const V2 = new Set(['inventory.fetchPrice', 'quote.created', 'quote.updated', 'quote.publishToOrderSystem', 'bom.publishToOrderSystem']);

// mockDirs: folders of mock deliveries; noCallbackMs: when an unanswered delivery is flagged.
function createPlayground({ mockDirs = [SAMPLES], noCallbackMs = 30000 } = {}) {
  mockDirs = mockDirs.map(d => path.resolve(d));
  const subs = new Map();   // eventType -> { version, url, publicKey, privateKey, previous: {publicKey, privateKey} | null, at }
  const prevKeys = new Map();   // eventType -> keys from before the last resubscribe (for 'Old key')
  const log = [];           // newest last: { id, at, kind: 'delivery'|'callback'|'subscribe'|'unsubscribe', ... }
  const push = entry => { log.push({ id: log.length + 1, at: new Date().toISOString(), ...entry }); if (log.length > 500) log.shift(); };
  const base = () => `http://127.0.0.1:${server.address() ? server.address().port : '?'}/platform-api/api/v1/`;

  // ---- mocks ----
  function typeFromFile(file) {
    const name = path.basename(file, '.json');
    const dotted = name.match(/^([a-zA-Z]+\.[a-zA-Z]+)/);
    if (dotted) return dotted[1];
    const under = name.match(/^([a-zA-Z]+)_([a-zA-Z]+)/);
    return under ? `${under[1]}.${under[2]}` : null;
  }

  function loadMocks() {
    const mocks = [];
    for (const dir of mockDirs) {
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort()) {
        const file = path.join(dir, f);
        try {
          const j = JSON.parse(fs.readFileSync(file, 'utf8'));
          const delivery = j.delivery || j;
          const eventType = j.eventType || typeFromFile(f);
          if (!eventType || typeof delivery !== 'object' || !('data' in delivery)) throw new Error('not a delivery (no data field) or no event type');
          const { eventType: _t, ...envelope } = delivery;
          mocks.push({ id: `${path.basename(dir)}/${f}`, file, eventType, version: j.version || (V2.has(eventType) ? 2 : 1),
            delivery: envelope, callback: j.callback || null });
        } catch (e) {
          mocks.push({ id: `${path.basename(dir)}/${f}`, file, error: e.message });
        }
      }
    }
    return mocks;
  }

  const newKeys = () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    return { publicKey: publicKey.export({ type: 'spki', format: 'pem' }), privateKey };
  };

  // ---- sending ----
  async function send({ eventType, body, mode = 'normal' }) {
    const sub = subs.get(eventType);
    if (!sub) throw new Error(`${eventType} has no subscription — subscribe first`);
    let envelope;
    try { envelope = JSON.parse(body); } catch (e) { throw new Error(`body is not valid JSON: ${e.message}`); }
    envelope.eventTransactionID = crypto.randomUUID();
    envelope.callback_url ||= 'integrations/events/callback';
    const raw = Buffer.from(JSON.stringify(envelope));
    // stale: the key from before the last resubscribe (a throwaway key if there was none).
    const signer = mode === 'stale' ? (sub.previous || newKeys()).privateKey : sub.privateKey;
    const signature = crypto.sign('RSA-SHA256', raw, signer).toString('base64');
    const wire = mode === 'tampered' ? Buffer.from(raw.toString().replace('"data":', '"data" :')) : raw;
    const copies = mode === 'twice' ? 2 : 1;
    const results = [];
    for (let n = 0; n < copies; n++) {
      let status;
      try {
        const res = await fetch(sub.url, { method: 'POST', body: wire,
          headers: { 'Content-Type': 'application/json', 'X-Signature': signature, 'Idempotency-Key': envelope.eventTransactionID },
          signal: AbortSignal.timeout(15000) });
        status = res.status;
      } catch (e) { status = `unreachable: ${e.cause ? e.cause.code || e.cause.message : e.message}`; }
      results.push(status);
      push({ kind: 'delivery', eventType, txid: envelope.eventTransactionID, mode, copy: copies > 1 ? n + 1 : null, url: sub.url, status, bytes: wire.length,
        expectCallback: mode === 'normal' || (mode === 'twice' && n === 0) });
    }
    return { txid: envelope.eventTransactionID, results };
  }

  // ---- HTTP ----
  const json = (res, status, body) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  const readBody = req => new Promise(r => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const raw = await readBody(req);
    let body = {};
    try { body = raw.length ? JSON.parse(raw) : {}; } catch { /* callbacks are JSON; anything else is reported below */ }
    const api = url.pathname.replace(/^\/platform-api\/api\/v1\//, '');

    // PM API surface
    if (api !== url.pathname) {
      if (!req.headers['x-api-key']) return json(res, 401, { error: 'missing x-api-key' });
      if (req.method === 'GET' && api === 'integrations/events/list') {
        const types = [...new Set(loadMocks().filter(m => m.eventType).map(m => m.eventType))];
        return json(res, 200, { availableEvents: Object.fromEntries(types.filter(t => !subs.has(t)).map(t => [t, t])), message: 'Success' });
      }
      if (req.method === 'PUT' && api === 'integrations/events/subscribe') {
        if (subs.has(body.event_type)) return json(res, 400, { error: `an active subscription already exists for event type ${body.event_type} and version ${subs.get(body.event_type).version}` });
        if (!body.event_type || !body.webhook_url) return json(res, 400, { error: 'event_type and webhook_url are required' });
        const keys = newKeys();
        subs.set(body.event_type, { version: body.event_version, url: body.webhook_url, ...keys, previous: prevKeys.get(body.event_type) || null, at: new Date().toISOString() });
        push({ kind: 'subscribe', eventType: body.event_type, url: body.webhook_url, version: body.event_version });
        return json(res, 200, { publicKey: keys.publicKey });
      }
      if (req.method === 'DELETE' && api === 'integrations/events/unsubscribe') {
        const sub = subs.get(body.event_type);
        if (!sub || sub.version !== body.event_version) return json(res, 404, { error: 'no such subscription' });
        prevKeys.set(body.event_type, { publicKey: sub.publicKey, privateKey: sub.privateKey });
        subs.delete(body.event_type);
        push({ kind: 'unsubscribe', eventType: body.event_type, version: body.event_version });
        return json(res, 200, { message: 'Success' });
      }
      if (req.method === 'POST') {   // callback_url is relative to this base; accept any path so custom ones work
        const delivered = [...log].reverse().find(e => e.kind === 'delivery' && e.txid === body.EventTransactionID);
        push({ kind: 'callback', path: api, eventType: delivered ? delivered.eventType : null, txid: body.EventTransactionID || null,
          status: body.EventStatus || null, body: raw.length && !Object.keys(body).length ? raw.toString().slice(0, 2000) : body,
          problem: !delivered ? 'no delivery with this EventTransactionID' : !['success', 'error'].includes(body.EventStatus) ? 'EventStatus must be "success" or "error"' : null });
        return json(res, 200, { message: 'Success' });
      }
      return json(res, 404, { error: `the playground does not implement ${req.method} ${api}` });
    }

    // Page API
    if (req.method === 'GET' && url.pathname === '/api/state') {
      const now = Date.now();
      const answered = new Set(log.filter(e => e.kind === 'callback').map(e => e.txid));
      return json(res, 200, {
        base: base(),
        mockDirs,
        mocks: loadMocks().map(({ file, ...m }) => m),
        subscriptions: [...subs].map(([eventType, s]) => ({ eventType, version: s.version, url: s.url, publicKey: s.publicKey, at: s.at })),
        log: log.map(e => e.kind === 'delivery' && e.expectCallback && !answered.has(e.txid)
          ? { ...e, awaiting: true, overdue: now - Date.parse(e.at) > noCallbackMs } : e),
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/subscribe') {   // subscribe from the page
      if (subs.has(body.eventType)) {
        const old = subs.get(body.eventType);
        prevKeys.set(body.eventType, { publicKey: old.publicKey, privateKey: old.privateKey });
      }
      const keys = newKeys();
      const version = body.version || (V2.has(body.eventType) ? 2 : 1);
      subs.set(body.eventType, { version, url: body.url, ...keys, previous: prevKeys.get(body.eventType) || null, at: new Date().toISOString() });
      push({ kind: 'subscribe', eventType: body.eventType, url: body.url, version, from: 'page' });
      return json(res, 200, { publicKey: keys.publicKey });
    }
    if (req.method === 'POST' && url.pathname === '/api/send') {
      try { return json(res, 200, await send(body)); } catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/clear') { log.length = 0; return json(res, 200, {}); }
    if (req.method === 'GET' && url.pathname === '/') {
      return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(fs.readFileSync(path.join(__dirname, 'playground.html')));
    }
    json(res, 404, { error: 'not found' });
  });


  return { server, send, subs, log, loadMocks, base,
    listen: (port = 0) => new Promise(r => server.listen(port, '127.0.0.1', () => r(server.address().port))) };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const opts = name => args.flatMap((a, i) => (a === `--${name}` ? [args[i + 1]] : []));
  const port = Number(opts('port')[0] || process.env.PORT || 4800);
  const extra = opts('mocks').length ? opts('mocks') : fs.existsSync('mocks') ? ['mocks'] : [];
  const pg = createPlayground({ mockDirs: [SAMPLES, ...extra] });
  pg.listen(port).then(() => {
    console.log(`PM playground on http://localhost:${port}`);
    console.log(`  SDK base URL: ${pg.base()}   (any x-api-key)`);
    console.log(`  mocks from:   ${[SAMPLES, ...extra].map(d => path.resolve(d)).filter(d => fs.existsSync(d)).join(', ')}`);
  });
}

module.exports = { createPlayground, SAMPLES };
