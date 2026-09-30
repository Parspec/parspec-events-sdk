// A stand-in for PM's events API, for `run.js live --fake`: subscribe mints a key and, shortly after,
// POSTs a signed delivery (twice, as PM's redelivery would) to the webhook URL; the catalog lists only
// unsubscribed events; a second subscription for the same event is refused the way PM refuses it.
'use strict';

const crypto = require('crypto');
const http = require('http');

function start(knownEvents) {
  const subs = new Map();       // eventType -> { version, url, privateKey }
  const callbacks = [];
  const json = (res, status, body) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));

  const deliver = (eventType, sub) => {
    const txid = crypto.randomUUID();
    const raw = Buffer.from(JSON.stringify({ eventTransactionID: txid, callback_url: 'integrations/events/callback', data: { fake: true, eventType } }));
    const signature = crypto.sign('RSA-SHA256', raw, sub.privateKey).toString('base64');
    const send = () => fetch(sub.url, { method: 'POST', body: raw, headers: { 'Content-Type': 'application/json', 'X-Signature': signature, 'Idempotency-Key': txid } }).catch(() => {});
    setTimeout(send, 300);
    setTimeout(send, 600);
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
      const route = `${req.method} ${req.url.replace(/^\/platform-api\/api\/v1\//, '')}`;
      if (route === 'GET integrations/events/list') {
        return json(res, 200, { availableEvents: Object.fromEntries(knownEvents.filter(e => !subs.has(e)).map(e => [e, e])), message: 'Success' });
      }
      if (route === 'PUT integrations/events/subscribe') {
        const existing = subs.get(body.event_type);
        if (existing) return json(res, 400, { error: `an active subscription already exists for event type ${body.event_type} and version ${existing.version}` });
        const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
        const sub = { version: body.event_version, url: body.webhook_url, privateKey };
        subs.set(body.event_type, sub);
        deliver(body.event_type, sub);
        return json(res, 200, { publicKey: publicKey.export({ type: 'spki', format: 'pem' }) });
      }
      if (route === 'DELETE integrations/events/unsubscribe') {
        const existing = subs.get(body.event_type);
        if (!existing || existing.version !== body.event_version) return json(res, 404, { error: 'no subscription' });
        subs.delete(body.event_type);
        return json(res, 200, { message: 'Success' });
      }
      if (route === 'POST integrations/events/callback') {
        callbacks.push(body);
        return json(res, 200, { message: 'Success' });
      }
      json(res, 404, { error: `fake PM has no ${route}` });
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({
    base: `http://127.0.0.1:${server.address().port}/platform-api/api/v1/`,
    callbacks,
    // Simulate another deployment already holding an event, so subscribe has to clear it.
    preSubscribe: (eventType, version) => subs.set(eventType, { version, url: 'http://127.0.0.1:9/elsewhere', privateKey: crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey }),
    close: () => server.close(),
  })));
}

module.exports = { start };
