// Regenerates the shared fixtures every language's tests run against:
//   keys/signer.pem, keys/other.pem  test RSA public keys (private halves are discarded)
//   keys/ec.pem, keys/not-a-key.pem  keys verify() must reject without throwing
//   signatures.json                  raw bodies + X-Signature values: `valid` (does it verify) and, for valid
//                                    ones, `envelope` (false: signed, but not a PM event, so parsing must fail
//                                    with an error that is NOT the signature error)
//   callbacks.json                   callback inputs and the exact request each SDK must send; an `expect`
//                                    without `method` means no request may be made at all
//   receiver.json                    scripted deliveries for the receiver (routing, duplicates, errors); see below
// subscribe.json is hand-written: scripted request/response exchanges.
//
// Run: node fixtures/generate.js   (keys are random, so every file changes; commit them together)

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const pair = () => crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const signer = pair();
const other = pair();
const pem = k => k.publicKey.export({ type: 'spki', format: 'pem' });
fs.writeFileSync(path.join(dir, 'keys/signer.pem'), pem(signer));
fs.writeFileSync(path.join(dir, 'keys/other.pem'), pem(other));
fs.writeFileSync(path.join(dir, 'keys/ec.pem'), crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ type: 'spki', format: 'pem' }));
fs.writeFileSync(path.join(dir, 'keys/not-a-key.pem'), 'this file is not a PEM key\n');

const sign = (body, key = signer) => crypto.sign('RSA-SHA256', Buffer.from(body, 'utf8'), key.privateKey).toString('base64');

// Synthetic events in PM's envelope. No customer data.
const envelope = (eventType, data) => ({ eventTransactionID: crypto.randomUUID(), callback_url: 'integrations/events/callback', data, _eventType: eventType });
const body = e => { const { _eventType, ...rest } = e; return JSON.stringify(rest); };

const order = envelope('tandemOrder.publishToErp', {
  project: { id: 1001, erpId: 'PRJ-1', name: 'Demo Project' },
  purchaseOrder: { erpId: '', releaseType: 'release', version: 1 },
  lineItems: [{ bomLineId: 1, modelNumber: 'DEMO-100', quantity: 5 }]
});
const quote = envelope('quote.publishToOrderSystem', {
  ParspecJSON: { Quote: { ID: '1001-2002-1', Status: 'Won' }, Project: { ID: 1001, Name: 'Chantier Montréal — Phase 2' } }
});

const orderBody = body(order);
const quoteBody = body(quote);
const pretty = JSON.stringify(JSON.parse(orderBody), null, 2);

const signatures = [
  { name: 'valid', body: orderBody, signature: sign(orderBody), key: 'signer.pem', valid: true },
  { name: 'valid, non-ASCII body', body: quoteBody, signature: sign(quoteBody), key: 'signer.pem', valid: true },
  { name: 'body tampered after signing', body: orderBody.replace('"quantity":5', '"quantity":50'), signature: sign(orderBody), key: 'signer.pem', valid: false },
  { name: 're-serialized body (parsed and pretty-printed)', body: pretty, signature: sign(orderBody), key: 'signer.pem', valid: false },
  { name: 'signed with a different key (stale key after resubscribe)', body: orderBody, signature: sign(orderBody, other), key: 'signer.pem', valid: false },
  { name: 'empty signature', body: orderBody, signature: '', key: 'signer.pem', valid: false },
  { name: 'signature is not base64', body: orderBody, signature: '%%%not-base64%%%', key: 'signer.pem', valid: false },
  { name: 'public key is an EC key, not RSA', body: orderBody, signature: sign(orderBody), key: 'ec.pem', valid: false },
  { name: 'public key file is not a PEM key', body: orderBody, signature: sign(orderBody), key: 'not-a-key.pem', valid: false },
  // Signed by PM's key but not a PM event: verifying succeeds, parsing must fail cleanly.
  ...[['a JSON array', '[1,2]'], ['not JSON', 'not json'], ['an object without eventTransactionID', '{"data":{}}']]
    .map(([what, b]) => ({ name: `signed, but the body is ${what}`, body: b, signature: sign(b), key: 'signer.pem', valid: true, envelope: false }))
];
fs.writeFileSync(path.join(dir, 'signatures.json'), JSON.stringify(signatures, null, 2) + '\n');

// Callback cases. `event` is what the SDK received; `expect` is the request it must make.
// Base URL for the cases: https://pm.example/platform-api/api/v1/
const txid = order.eventTransactionID;
const evt = { eventTransactionID: txid, callback_url: 'integrations/events/callback' };
const callbacks = [
  {
    name: 'success with order ids',
    call: 'success', event: evt, fields: { orderId: 'SO-123', projectErpId: 'PRJ-1' },
    expect: { method: 'POST', url: 'https://pm.example/platform-api/api/v1/integrations/events/callback',
      body: { EventTransactionID: txid, EventStatus: 'success', orderId: 'SO-123', projectErpId: 'PRJ-1' } }
  },
  {
    name: 'plain acknowledgement',
    call: 'success', event: evt, fields: {},
    expect: { method: 'POST', url: 'https://pm.example/platform-api/api/v1/integrations/events/callback',
      body: { EventTransactionID: txid, EventStatus: 'success' } }
  },
  {
    name: 'error with message (shown to the PM user)',
    call: 'error', event: evt, message: 'Credit check failed for customer C-42',
    expect: { method: 'POST', url: 'https://pm.example/platform-api/api/v1/integrations/events/callback',
      body: { EventTransactionID: txid, EventStatus: 'error', errorMessage: 'Credit check failed for customer C-42' } }
  },
  {
    name: 'missing callback_url falls back to the default path',
    call: 'success', event: { eventTransactionID: txid }, fields: {},
    expect: { method: 'POST', url: 'https://pm.example/platform-api/api/v1/integrations/events/callback',
      body: { EventTransactionID: txid, EventStatus: 'success' } }
  },
  {
    name: 'absolute callback_url on the PM host is used',
    call: 'success', event: { eventTransactionID: txid, callback_url: 'https://pm.example/platform-api/api/v1/custom/callback' }, fields: {},
    expect: { method: 'POST', url: 'https://pm.example/platform-api/api/v1/custom/callback',
      body: { EventTransactionID: txid, EventStatus: 'success' } }
  },
  {
    // The API key goes with every callback, so it must never be sent to a host the payload names.
    name: 'absolute callback_url on another host is refused, nothing sent',
    call: 'success', event: { eventTransactionID: txid, callback_url: 'https://callbacks.example/hook' }, fields: {},
    expect: { error: 0 }
  },
  {
    name: 'absolute callback_url with an upper-case scheme on another host is refused',
    call: 'success', event: { eventTransactionID: txid, callback_url: 'HTTPS://callbacks.example/hook' }, fields: {},
    expect: { error: 0 }
  },
  {
    // The SDK owns these two: a caller's fields must not be able to forge them.
    name: 'fields cannot override EventTransactionID or EventStatus',
    call: 'success', event: evt, fields: { EventTransactionID: 'forged', EventStatus: 'error', orderId: 'SO-1' },
    expect: { method: 'POST', url: 'https://pm.example/platform-api/api/v1/integrations/events/callback',
      body: { EventTransactionID: txid, EventStatus: 'success', orderId: 'SO-1' } }
  },
  {
    name: 'callback rejected with 400 raises with the status',
    call: 'success', event: evt, fields: {},
    response: { status: 400, body: { error: 'bad request' } },
    expect: { method: 'POST', url: 'https://pm.example/platform-api/api/v1/integrations/events/callback',
      body: { EventTransactionID: txid, EventStatus: 'success' }, error: 400 }
  },
  {
    // `response.network`: the fake transport fails before any response (connection refused, timeout).
    name: 'network failure raises the SDK error with status 0',
    call: 'success', event: evt, fields: {},
    response: { network: true },
    expect: { method: 'POST', url: 'https://pm.example/platform-api/api/v1/integrations/events/callback',
      body: { EventTransactionID: txid, EventStatus: 'success' }, error: 0 }
  },
  {
    // `response` is what the fake server returns; `expect.error` is the status the SDK must raise with.
    name: 'rejected callback raises with the status',
    call: 'success', event: evt, fields: {},
    response: { status: 500, body: { error: 'internal' } },
    expect: { method: 'POST', url: 'https://pm.example/platform-api/api/v1/integrations/events/callback',
      body: { EventTransactionID: txid, EventStatus: 'success' }, error: 500 }
  }
];
fs.writeFileSync(path.join(dir, 'callbacks.json'), JSON.stringify(callbacks, null, 2) + '\n');

// Receiver scenarios. Each one sets up:
//   keys          eventType -> key file: what the receiver's key store returns (signer.pem, other.pem)
//   processing    transaction ids another worker already claimed; done: ids already finished
//   handlers      eventType -> behaviours for successive calls ({return: fields|null} or {throw: message});
//                 the last behaviour repeats
//   callbackResponses  statuses PM answers callbacks with, in order (default 200)
//   deliveries    raw bodies + X-Signature, each with the HTTP status the receiver must answer
// and expects: the handler calls made, every callback request sent (even failed ones), and which
// transactions end up done or still processing. Callback base URL: https://pm.example/platform-api/api/v1/
const A = 'tandemOrder.publishToErp', B = 'inventory.fetchPrice';
const stranger = pair();
const signed = (key, data) => { const txid = crypto.randomUUID(); const b = JSON.stringify({ eventTransactionID: txid, callback_url: 'integrations/events/callback', data }); return { txid, body: b, signature: sign(b, key) }; };
const deliver = (d, status = 200) => ({ body: d.body, signature: d.signature, status });
const ok = (txid, fields = {}) => ({ EventTransactionID: txid, EventStatus: 'success', ...fields });
const keysAB = { [A]: 'signer.pem', [B]: 'other.pem' };
const scenarios = [];
{ const d = signed(other, { sku: 'DEMO-100' });
  scenarios.push({ name: 'routes to the handler whose key verifies', keys: keysAB,
    handlers: { [A]: [{ return: { orderId: 'SO-1' } }], [B]: [{ return: { unitPrice: '12.3400' } }] },
    deliveries: [deliver(d)],
    expect: { calls: [{ eventType: B, transactionId: d.txid }], callbacks: [ok(d.txid, { unitPrice: '12.3400' })], done: [d.txid], processing: [] } }); }
{ const d = signed(stranger, { sku: 'DEMO-100' });
  scenarios.push({ name: 'a delivery no stored key verifies is refused', keys: keysAB,
    handlers: { [A]: [{ return: {} }] }, deliveries: [deliver(d, 401)],
    expect: { calls: [], callbacks: [], done: [], processing: [] } }); }
{ const d = signed(signer, { po: 1 });
  scenarios.push({ name: 'a duplicate delivery is acknowledged but processed once', keys: keysAB,
    handlers: { [A]: [{ return: { orderId: 'SO-1' } }] }, deliveries: [deliver(d), deliver(d)],
    expect: { calls: [{ eventType: A, transactionId: d.txid }], callbacks: [ok(d.txid, { orderId: 'SO-1' })], done: [d.txid], processing: [] } }); }
{ const d = signed(signer, { po: 1 });
  scenarios.push({ name: 'a transaction another worker is processing is not run again', keys: keysAB, processing: [d.txid],
    handlers: { [A]: [{ return: { orderId: 'SO-1' } }] }, deliveries: [deliver(d)],
    expect: { calls: [], callbacks: [], done: [], processing: [d.txid] } }); }
{ const d = signed(signer, { po: 1 });
  scenarios.push({ name: 'a transaction already done is not run again', keys: keysAB, done: [d.txid],
    handlers: { [A]: [{ return: { orderId: 'SO-1' } }] }, deliveries: [deliver(d)],
    expect: { calls: [], callbacks: [], done: [d.txid], processing: [] } }); }
{ const d = signed(signer, { po: 1 });
  scenarios.push({ name: 'a handler that throws sends an error callback and releases the claim, so a redelivery retries', keys: keysAB,
    handlers: { [A]: [{ throw: 'ERP offline' }, { return: { orderId: 'SO-2' } }] }, deliveries: [deliver(d), deliver(d)],
    expect: { calls: [{ eventType: A, transactionId: d.txid }, { eventType: A, transactionId: d.txid }],
      callbacks: [{ EventTransactionID: d.txid, EventStatus: 'error', errorMessage: 'ERP offline' }, ok(d.txid, { orderId: 'SO-2' })],
      done: [d.txid], processing: [] } }); }
{ const d = signed(other, { sku: 'DEMO-100' });
  scenarios.push({ name: 'an event with a key but no handler gets a plain acknowledgement', keys: keysAB,
    handlers: { [A]: [{ return: {} }] }, deliveries: [deliver(d)],
    expect: { calls: [], callbacks: [ok(d.txid)], done: [d.txid], processing: [] } }); }
{ const b = '[1,2]';
  scenarios.push({ name: 'a signed body that is not a PM event is rejected', keys: keysAB,
    handlers: { [A]: [{ return: {} }] }, deliveries: [{ body: b, signature: sign(b), status: 400 }],
    expect: { calls: [], callbacks: [], done: [], processing: [] } }); }
{ const d = signed(signer, { po: 1 });
  scenarios.push({ name: 'a failed callback releases the claim, so a redelivery runs the handler again', keys: keysAB,
    handlers: { [A]: [{ return: { orderId: 'SO-1' } }] }, callbackResponses: [500, 200], deliveries: [deliver(d), deliver(d)],
    expect: { calls: [{ eventType: A, transactionId: d.txid }, { eventType: A, transactionId: d.txid }],
      callbacks: [ok(d.txid, { orderId: 'SO-1' }), ok(d.txid, { orderId: 'SO-1' })], done: [d.txid], processing: [] } }); }
{ const d = signed(signer, { po: 1 });
  scenarios.push({ name: 'a handler that returns nothing sends a plain acknowledgement', keys: keysAB,
    handlers: { [A]: [{ return: null }] }, deliveries: [deliver(d)],
    expect: { calls: [{ eventType: A, transactionId: d.txid }], callbacks: [ok(d.txid)], done: [d.txid], processing: [] } }); }
fs.writeFileSync(path.join(dir, 'receiver.json'), JSON.stringify(scenarios, null, 2) + '\n');

console.log(`wrote ${signatures.length} signature cases, ${callbacks.length} callback cases, ${scenarios.length} receiver scenarios`);
