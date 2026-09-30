// Runs the shared fixtures in ../fixtures. `node --test`
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createClient, createReceiver, memoryKeys, memoryTransactions, verify, parseEvent, SignatureError, EventError } = require('./index.js');

const fx = f => path.join(__dirname, '../fixtures', f);
const load = f => JSON.parse(fs.readFileSync(fx(f), 'utf8'));
const BASE = 'https://pm.example/platform-api/api/v1/';

for (const c of load('signatures.json')) {
  test(`signature: ${c.name}`, () => {
    const key = fs.readFileSync(fx(`keys/${c.key}`), 'utf8');
    assert.strictEqual(verify(Buffer.from(c.body, 'utf8'), c.signature, key), c.valid);
    // Node lowercases incoming header names; other frameworks don't. Both must work.
    for (const headers of [{ 'x-signature': c.signature, 'idempotency-key': 'idem-1' }, { 'X-Signature': c.signature, 'Idempotency-Key': 'idem-1' }]) {
      if (!c.valid) assert.throws(() => parseEvent(c.body, headers, key), SignatureError);
      else if (c.envelope === false) assert.throws(() => parseEvent(c.body, headers, key), e => e instanceof EventError && !(e instanceof SignatureError));
      else {
        const { event, transactionId, idempotencyKey } = parseEvent(c.body, headers, key);
        assert.strictEqual(transactionId, event.eventTransactionID);
        assert.strictEqual(idempotencyKey, 'idem-1');
      }
    }
  });
}

// Fake fetch that records requests and replays canned responses.
function fakeFetch(responses = []) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ method: init.method, url, headers: init.headers, body: JSON.parse(init.body) });
    const r = responses[calls.length - 1] || { status: 200, body: {} };
    if (r.network) throw new TypeError('fetch failed');
    return { status: r.status, text: async () => JSON.stringify(r.body) };
  };
  return { fetch, calls };
}

for (const c of load('callbacks.json')) {
  test(`callback: ${c.name}`, async () => {
    const { fetch, calls } = fakeFetch(c.response ? [c.response] : []);
    const client = createClient({ apiKey: 'k', baseUrl: BASE, fetch });
    const run = c.call === 'error' ? client.fail(c.event, c.message) : client.callback(c.event, c.fields);
    if ('error' in c.expect) await assert.rejects(run, e => e.status === c.expect.error);
    else await run;
    if (!c.expect.method) return assert.strictEqual(calls.length, 0, 'no request may be sent');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].method, c.expect.method);
    assert.strictEqual(calls[0].url, c.expect.url);
    assert.deepStrictEqual(calls[0].body, c.expect.body);
    assert.strictEqual(calls[0].headers['x-api-key'], 'k');
  });
}

for (const c of load('subscribe.json')) {
  test(`subscribe: ${c.name}`, async () => {
    const { fetch, calls } = fakeFetch(c.exchange.map(x => x.response));
    const client = createClient({ apiKey: 'k', baseUrl: BASE, fetch });
    const run = client.subscribe(c.args.eventType, c.args.version, c.args.webhookUrl);
    if ('error' in c.expect) await assert.rejects(run, e => e.status === c.expect.error);
    else assert.deepStrictEqual(await run, c.expect);
    assert.deepStrictEqual(calls.map(x => ({ method: x.method, path: x.url.slice(BASE.length), body: x.body })), c.exchange.map(x => x.request));
  });
}

test('client: constructor validation, environments, trailing slash, timeout', async () => {
  assert.throws(() => createClient({ baseUrl: BASE }), /apiKey is required/);
  assert.throws(() => createClient({ apiKey: 'k', environment: 'nowhere' }), /unknown environment/);
  const urls = [];
  const fetch = async url => { urls.push(url); return { status: 200, text: async () => '{}' }; };
  await createClient({ apiKey: 'k', environment: 'sandbox', fetch }).callback({ eventTransactionID: 't' });
  await createClient({ apiKey: 'k', baseUrl: BASE.slice(0, -1), fetch }).callback({ eventTransactionID: 't' });
  assert.deepStrictEqual(urls, ['https://platform-sandbox.parspec.io/platform-api/api/v1/integrations/events/callback', BASE + 'integrations/events/callback']);
  // A real fetch holds a socket open while it waits; this fake holds a timer instead, because the
  // AbortSignal.timeout timer alone does not keep Node's event loop alive (Node 22 exits early).
  const hang = (url, init) => new Promise((_, reject) => {
    const keepAlive = setTimeout(() => {}, 10000);
    init.signal.addEventListener('abort', () => { clearTimeout(keepAlive); reject(init.signal.reason); });
  });
  await assert.rejects(createClient({ apiKey: 'k', baseUrl: BASE, fetch: hang, timeoutMs: 20 }).callback({ eventTransactionID: 't' }), e => e.status === 0);
});

test('unsubscribe: an explicit version clears only that version', async () => {
  const { fetch, calls } = fakeFetch([{ status: 200, body: {} }]);
  const out = await createClient({ apiKey: 'k', baseUrl: BASE, fetch }).unsubscribe('quote.created', 2);
  assert.deepStrictEqual(out, [{ version: 2, status: 200 }]);
  assert.deepStrictEqual(calls.map(c => c.body), [{ event_type: 'quote.created', event_version: 2 }]);
});

// ---- receiver ----

// A store the test writes itself, as a developer would: proves the interfaces are all the receiver needs.
function testStores(c) {
  const keyMap = Object.fromEntries(Object.entries(c.keys).map(([t, f]) => [t, fs.readFileSync(fx(`keys/${f}`), 'utf8')]));
  const processing = new Set(c.processing || []), done = new Set(c.done || []);
  return {
    processing, done,
    keys: { get: async () => keyMap },   // read-only, like env vars
    transactions: {
      claim: async t => { if (processing.has(t) || done.has(t)) return false; processing.add(t); return true; },
      done: async t => { processing.delete(t); done.add(t); },
      release: async t => { processing.delete(t); }
    }
  };
}

for (const c of load('receiver.json')) {
  test(`receiver: ${c.name}`, async () => {
    const statuses = [...(c.callbackResponses || [])];
    const { fetch, calls: sent } = fakeFetch(statuses.map(status => ({ status, body: {} })));
    const client = createClient({ apiKey: 'k', baseUrl: BASE, fetch });
    const stores = testStores(c);
    const receiver = createReceiver({ client, keys: stores.keys, transactions: stores.transactions });
    const calls = [];
    for (const [eventType, behaviours] of Object.entries(c.handlers)) {
      let n = 0;
      receiver.on(eventType, async (event, ctx) => {
        calls.push({ eventType: ctx.eventType, transactionId: ctx.transactionId });
        const b = behaviours[Math.min(n++, behaviours.length - 1)];
        if (b.throw) throw new Error(b.throw);
        return b.return;
      });
    }
    const got = [];
    for (const d of c.deliveries) got.push(await receiver.handle(Buffer.from(d.body), { 'x-signature': d.signature }));
    assert.deepStrictEqual(got, c.deliveries.map(d => d.status));
    assert.deepStrictEqual(calls, c.expect.calls);
    assert.deepStrictEqual(sent.map(x => x.body), c.expect.callbacks);
    assert.ok(sent.every(x => x.url === BASE + 'integrations/events/callback'));
    assert.deepStrictEqual([...stores.done].sort(), [...c.expect.done].sort());
    assert.deepStrictEqual([...stores.processing].sort(), [...c.expect.processing].sort());
  });
}

test('receiver: subscribe stores each new key when the key store can write, and returns them', async () => {
  const { fetch, calls } = fakeFetch([
    { status: 200, body: {} }, { status: 200, body: {} }, { status: 200, body: { publicKey: 'KEY-A' } },
    { status: 200, body: {} }, { status: 200, body: {} }, { status: 200, body: { publicKey: 'KEY-B' } }]);
  const keys = memoryKeys();
  const receiver = createReceiver({ client: createClient({ apiKey: 'k', baseUrl: BASE, fetch }), keys })
    .on('tandemOrder.publishToErp', () => {})
    .on('inventory.fetchPrice', () => {}, { version: 2 });
  assert.deepStrictEqual(await receiver.subscribe('https://erp.example/hook'), { 'tandemOrder.publishToErp': 'KEY-A', 'inventory.fetchPrice': 'KEY-B' });
  assert.deepStrictEqual(keys.get(), { 'tandemOrder.publishToErp': 'KEY-A', 'inventory.fetchPrice': 'KEY-B' });
  assert.deepStrictEqual(calls.filter(c => c.method === 'PUT').map(c => [c.body.event_type, c.body.event_version, c.body.webhook_url]),
    [['tandemOrder.publishToErp', 1, 'https://erp.example/hook'], ['inventory.fetchPrice', 2, 'https://erp.example/hook']]);
});

test('receiver: a read-only key store (no set) still gets the new keys back from subscribe', async () => {
  const { fetch } = fakeFetch([{ status: 200, body: {} }, { status: 200, body: {} }, { status: 200, body: { publicKey: 'KEY-A' } }]);
  const receiver = createReceiver({ client: createClient({ apiKey: 'k', baseUrl: BASE, fetch }), keys: { get: () => ({}) } }).on('tandemOrder.publishToErp', () => {});
  assert.deepStrictEqual(await receiver.subscribe('https://erp.example/hook'), { 'tandemOrder.publishToErp': 'KEY-A' });
});

test('receiver: memoryTransactions claims once, and a stale claim can be taken over', async () => {
  const t = memoryTransactions({ leaseMs: 20 });
  assert.strictEqual(t.claim('a'), true);
  assert.strictEqual(t.claim('a'), false, 'in progress');
  await new Promise(r => setTimeout(r, 30));
  assert.strictEqual(t.claim('a'), true, 'lease expired: the worker is presumed dead');
  t.done('a');
  assert.strictEqual(t.claim('a'), false, 'done');
  t.release('a');
  assert.strictEqual(t.claim('b'), true);
  t.release('b');
  assert.strictEqual(t.claim('b'), true, 'released: can be claimed again');
});

test('receiver: accept answers before the handler runs', async () => {
  const c = load('receiver.json')[0];
  const { fetch } = fakeFetch();
  const stores = testStores(c);
  let ran = false;
  const receiver = createReceiver({ client: createClient({ apiKey: 'k', baseUrl: BASE, fetch }), keys: stores.keys, transactions: stores.transactions })
    .on('inventory.fetchPrice', async () => { ran = true; });
  const r = await receiver.accept(Buffer.from(c.deliveries[0].body), { 'X-Signature': c.deliveries[0].signature });
  assert.deepStrictEqual([r.status, r.eventType, ran], [200, 'inventory.fetchPrice', false]);
  await r.process();
  assert.strictEqual(ran, true);
});
