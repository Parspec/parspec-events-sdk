// Runs the shared fixtures in ../fixtures. `node --test`
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createClient, verify, parseEvent, SignatureError, EventError } = require('./index.js');

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
  const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  await assert.rejects(createClient({ apiKey: 'k', baseUrl: BASE, fetch: hang, timeoutMs: 20 }).callback({ eventTransactionID: 't' }), e => e.status === 0);
});

test('unsubscribe: an explicit version clears only that version', async () => {
  const { fetch, calls } = fakeFetch([{ status: 200, body: {} }]);
  const out = await createClient({ apiKey: 'k', baseUrl: BASE, fetch }).unsubscribe('quote.created', 2);
  assert.deepStrictEqual(out, [{ version: 2, status: 200 }]);
  assert.deepStrictEqual(calls.map(c => c.body), [{ event_type: 'quote.created', event_version: 2 }]);
});
