// End-to-end tests for the playground: a real receiver built on the Node SDK, the PM API surface,
// the page API, and mock loading. Run: node --test harness/playground.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createPlayground, SAMPLES } = require('./playground.js');
const sdk = require('../node/index.js');

const wait = ms => new Promise(r => setTimeout(r, ms));
// Poll instead of sleeping a fixed time: fast when things are fast, patient on a slow CI runner.
async function until(cond, what, ms = 5000) {
  const end = Date.now() + ms;
  while (!(await cond())) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await wait(20); }
}
// Every server a test opens is closed after it, pass or fail, so a failure cannot hang the run.
const open = [];
test.afterEach(() => { for (const s of open.splice(0)) s.closeAllConnections?.(), s.close(); });
const listen = s => new Promise(r => { open.push(s); s.listen(0, '127.0.0.1', () => r(s.address().port)); });
const api = (pg, p) => pg.base().replace(/platform-api.*/, p.replace(/^\//, ''));
const post = (url, body, headers = {}) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const state = async pg => (await fetch(api(pg, '/api/state'))).json();

// A receiver built on the SDK, the way a developer would write one. `respond` decides the callback.
async function receiver(client, { respond = e => client.callback(e, { orderId: 'SO-1' }) } = {}) {
  const r = { keys: {}, seen: new Set() };
  r.server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks);
      const key = Object.values(r.keys).find(k => sdk.verify(raw, req.headers['x-signature'], k));
      if (!key) return res.writeHead(401).end();
      const { event, transactionId } = sdk.parseEvent(raw, req.headers, key);
      res.writeHead(200).end();
      if (r.seen.has(transactionId)) return;
      r.seen.add(transactionId);
      await respond(event);
    });
  });
  r.url = `http://127.0.0.1:${await listen(r.server)}/webhook`;
  return r;
}

async function setup(opts) {
  const pg = createPlayground(opts);
  open.push(pg.server);
  await pg.listen(0);
  return { pg, client: sdk.createClient({ apiKey: 'dev', baseUrl: pg.base() }) };
}

const body = JSON.stringify({ callback_url: 'integrations/events/callback', data: { demo: true } });

test('receiver flow: callback, duplicate, tampered, old key', async () => {
  const { pg, client } = await setup();
  const rx = await receiver(client);
  await client.subscribe('tandemOrder.publishToErp', 1, rx.url);   // first key becomes the "old" one
  rx.keys.t = (await client.subscribe('tandemOrder.publishToErp', 1, rx.url)).publicKey;

  const normal = await pg.send({ eventType: 'tandemOrder.publishToErp', body });
  const twice = await pg.send({ eventType: 'tandemOrder.publishToErp', body, mode: 'twice' });
  const tampered = await pg.send({ eventType: 'tandemOrder.publishToErp', body, mode: 'tampered' });
  const stale = await pg.send({ eventType: 'tandemOrder.publishToErp', body, mode: 'stale' });
  await until(() => pg.log.filter(e => e.kind === 'callback').length >= 2, 'two callbacks');
  await wait(100);   // a late extra callback would be a bug: give one the chance to arrive

  assert.deepStrictEqual([normal.results, twice.results, tampered.results, stale.results], [[200], [200, 200], [401], [401]]);
  const cbs = pg.log.filter(e => e.kind === 'callback');
  assert.deepStrictEqual(cbs.map(c => c.txid).sort(), [normal.txid, twice.txid].sort(), 'one callback per transaction');
  assert.ok(cbs.every(c => c.status === 'success' && c.body.orderId === 'SO-1' && !c.problem && c.eventType === 'tandemOrder.publishToErp'));
  const s = await state(pg);
  assert.strictEqual(s.log.filter(e => e.awaiting).length, 0, 'nothing left waiting');
});

test('every sample in fixtures/samples loads, and every one can be delivered and answered', async () => {
  const { pg, client } = await setup();
  const mocks = pg.loadMocks();
  assert.strictEqual(mocks.length, fs.readdirSync(SAMPLES).filter(f => f.endsWith('.json')).length);
  assert.deepStrictEqual(mocks.filter(m => m.error), []);
  const rx = await receiver(client);
  for (const m of mocks) rx.keys[m.eventType] = (await client.subscribe(m.eventType, m.version, rx.url)).publicKey;
  for (const m of mocks) assert.deepStrictEqual((await pg.send({ eventType: m.eventType, body: JSON.stringify(m.delivery) })).results, [200], m.eventType);
  await until(() => pg.log.filter(e => e.kind === 'callback').length >= mocks.length, 'a callback per sample');
  const answered = new Set(pg.log.filter(e => e.kind === 'callback' && !e.problem).map(e => e.eventType));
  assert.deepStrictEqual([...answered].sort(), mocks.map(m => m.eventType).sort());
});

test('mocks: dropped-in files in every accepted format, re-read without a restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-mocks-'));
  const envelope = { eventTransactionID: 'x', callback_url: 'integrations/events/callback', data: { a: 1 } };
  fs.writeFileSync(path.join(dir, 'sample.json'), JSON.stringify({ eventType: 'salesOrder.publishToErp', version: 1, delivery: envelope, callback: { orderId: 'SO-9' } }));
  fs.writeFileSync(path.join(dir, 'inventory_fetchPrice-1a2b3c4d.json'), JSON.stringify(envelope));   // mock-erp recording name
  fs.writeFileSync(path.join(dir, 'quote.created.json'), JSON.stringify(envelope));
  fs.writeFileSync(path.join(dir, 'anything.json'), JSON.stringify({ ...envelope, eventType: 'tandemOrder.orderRelease' }));
  fs.writeFileSync(path.join(dir, 'broken.json'), '{nope');
  fs.writeFileSync(path.join(dir, 'no-data.json'), JSON.stringify({ eventType: 'quote.created', hello: 1 }));
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignored');
  const { pg } = await setup({ mockDirs: [dir] });

  const byFile = Object.fromEntries((await state(pg)).mocks.map(m => [m.id.split('/').pop(), m]));
  assert.deepStrictEqual(Object.keys(byFile).sort(), ['anything.json', 'broken.json', 'inventory_fetchPrice-1a2b3c4d.json', 'no-data.json', 'quote.created.json', 'sample.json']);
  assert.strictEqual(byFile['sample.json'].eventType, 'salesOrder.publishToErp');
  assert.deepStrictEqual(byFile['sample.json'].callback, { orderId: 'SO-9' });
  assert.deepStrictEqual([byFile['inventory_fetchPrice-1a2b3c4d.json'].eventType, byFile['inventory_fetchPrice-1a2b3c4d.json'].version], ['inventory.fetchPrice', 2]);
  assert.strictEqual(byFile['quote.created.json'].eventType, 'quote.created');
  assert.strictEqual(byFile['anything.json'].eventType, 'tandemOrder.orderRelease');
  assert.ok(!('eventType' in byFile['anything.json'].delivery), 'eventType is not sent as part of the body');
  assert.match(byFile['broken.json'].error, /JSON/);
  assert.match(byFile['no-data.json'].error, /no data field/);

  fs.writeFileSync(path.join(dir, 'receivingTicket.publishToErp.json'), JSON.stringify(envelope));
  assert.ok((await state(pg)).mocks.some(m => m.eventType === 'receivingTicket.publishToErp'), 'new file shows up on the next read');
  fs.rmSync(dir, { recursive: true });
});

test('PM API: key required, catalog hides subscribed events, conflict and unsubscribe behave like PM', async () => {
  const { pg, client } = await setup();
  assert.strictEqual((await fetch(pg.base() + 'integrations/events/list')).status, 401, 'no x-api-key');
  const catalog = async () => Object.keys((await (await fetch(pg.base() + 'integrations/events/list', { headers: { 'x-api-key': 'k' } })).json()).availableEvents);
  assert.strictEqual((await catalog()).length, fs.readdirSync(SAMPLES).filter(f => f.endsWith('.json')).length);

  const put = b => fetch(pg.base() + 'integrations/events/subscribe', { method: 'PUT', headers: { 'x-api-key': 'k', 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
  const first = await put({ event_type: 'quote.created', event_version: 2, webhook_url: 'http://127.0.0.1:9/x' });
  assert.strictEqual(first.status, 200);
  assert.match((await first.json()).publicKey, /BEGIN PUBLIC KEY/);
  assert.ok(!(await catalog()).includes('quote.created'));
  const again = await put({ event_type: 'quote.created', event_version: 2, webhook_url: 'http://127.0.0.1:9/x' });
  assert.strictEqual(again.status, 400);
  assert.match((await again.json()).error, /already exists for event type quote.created and version 2/);

  const del = v => fetch(pg.base() + 'integrations/events/unsubscribe', { method: 'DELETE', headers: { 'x-api-key': 'k', 'Content-Type': 'application/json' }, body: JSON.stringify({ event_type: 'quote.created', event_version: v }) });
  assert.strictEqual((await del(1)).status, 404, 'wrong version');
  assert.strictEqual((await del(2)).status, 200);
  assert.ok((await catalog()).includes('quote.created'));

  // The SDK's subscribe takes over an existing subscription.
  await put({ event_type: 'quote.created', event_version: 2, webhook_url: 'http://127.0.0.1:9/someone-else' });
  const r = await client.subscribe('quote.created', 2, 'http://127.0.0.1:9/mine');
  assert.match(r.publicKey, /BEGIN PUBLIC KEY/);
  assert.strictEqual((await state(pg)).subscriptions.find(s => s.eventType === 'quote.created').url, 'http://127.0.0.1:9/mine');
});

test('callbacks: error callbacks, unknown transaction ids and bad EventStatus are reported', async () => {
  const { pg, client } = await setup();
  const rx = await receiver(client, { respond: e => client.fail(e, 'Credit check failed for C-42') });
  rx.keys.s = (await client.subscribe('salesOrder.publishToErp', 1, rx.url)).publicKey;
  const sent = await pg.send({ eventType: 'salesOrder.publishToErp', body });
  await until(() => pg.log.some(e => e.kind === 'callback' && e.txid === sent.txid), 'the error callback');
  const err = pg.log.find(e => e.kind === 'callback' && e.txid === sent.txid);
  assert.strictEqual(err.status, 'error');
  assert.strictEqual(err.body.errorMessage, 'Credit check failed for C-42');
  assert.strictEqual(err.problem, null);

  await post(pg.base() + 'integrations/events/callback', { EventTransactionID: 'not-a-real-id', EventStatus: 'success' }, { 'x-api-key': 'k' });
  await post(pg.base() + 'integrations/events/callback', { EventTransactionID: sent.txid, EventStatus: 'done' }, { 'x-api-key': 'k' });
  const [unknown, bad] = pg.log.filter(e => e.kind === 'callback').slice(-2);
  assert.match(unknown.problem, /no delivery with this EventTransactionID/);
  assert.match(bad.problem, /EventStatus must be/);
});

test('a delivery nobody answers is flagged overdue', async () => {
  const { pg, client } = await setup({ noCallbackMs: 100 });
  const rx = await receiver(client, { respond: async () => {} });   // acknowledges, never calls back
  rx.keys.o = (await client.subscribe('tandemOrder.orderRelease', 1, rx.url)).publicKey;
  await pg.send({ eventType: 'tandemOrder.orderRelease', body });
  assert.ok((await state(pg)).log.find(e => e.kind === 'delivery').awaiting);
  await wait(150);
  assert.ok((await state(pg)).log.find(e => e.kind === 'delivery').overdue);
});

test('page API: subscribe from the page, send errors, clear, and the page itself', async () => {
  const { pg } = await setup();
  const sub = await (await post(api(pg, '/api/subscribe'), { eventType: 'inventory.fetchPrice', url: 'http://127.0.0.1:9/nowhere' })).json();
  assert.match(sub.publicKey, /BEGIN PUBLIC KEY/);
  const listed = (await state(pg)).subscriptions.find(s => s.eventType === 'inventory.fetchPrice');
  assert.deepStrictEqual([listed.version, listed.publicKey], [2, sub.publicKey]);

  const send = b => post(api(pg, '/api/send'), b).then(async r => ({ status: r.status, ...(await r.json()) }));
  assert.match((await send({ eventType: 'quote.updated', body })).error, /no subscription/);
  assert.match((await send({ eventType: 'inventory.fetchPrice', body: '{not json' })).error, /not valid JSON/);
  const unreachable = await send({ eventType: 'inventory.fetchPrice', body });
  assert.match(String(unreachable.results[0]), /unreachable/);

  await post(api(pg, '/api/clear'), {});
  assert.strictEqual((await state(pg)).log.length, 0);

  const page = await fetch(api(pg, '/'));
  assert.strictEqual(page.status, 200);
  const html = await page.text();
  assert.match(html, /<title>PM Playground<\/title>/);
  // The page's script must at least parse, and every element it looks up must exist.
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
  assert.doesNotThrow(() => new Function(script));
  for (const id of new Set([...script.matchAll(/\$\('([\w-]+)'\)/g)].map(m => m[1]))) assert.match(html, new RegExp(`id="${id}"`), `#${id} missing from the page`);
});

test('guards: bad bodies get errors, not a crash; the page API refuses other origins', async () => {
  const { pg } = await setup();
  const raw = (p, init) => fetch(api(pg, p), init).then(r => r.status);
  // Bodies that used to crash the process: JSON null, an array, a string, and garbage.
  for (const data of ['null', '[1]', '"x"', '{nope']) {
    assert.strictEqual(await raw('/platform-api/api/v1/integrations/events/subscribe', { method: 'PUT', headers: { 'x-api-key': 'k' }, body: data }), 400, data);
  }
  assert.strictEqual(await raw('/api/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'null' }), 400);
  // A web page can send text/plain without a preflight: refused. So is a foreign Origin, even as JSON.
  assert.strictEqual(await raw('/api/subscribe', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"eventType":"x","url":"http://127.0.0.1:9"}' }), 415);
  assert.strictEqual(await raw('/api/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{"eventType":"x","url":"http://127.0.0.1:9"}' }), 403);
  assert.strictEqual(await raw('/api/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"eventType":"x","url":"file:///etc/passwd"}' }), 400);
  // DNS rebinding: a request whose Host is not localhost.
  const rebind = await new Promise(r => http.get({ host: '127.0.0.1', port: new URL(pg.base()).port, path: '/api/state', headers: { Host: 'evil.example' } }, res => { res.resume(); r(res.statusCode); }));
  assert.strictEqual(rebind, 421);
  assert.strictEqual((await state(pg)).subscriptions.length, 0, 'none of the refused requests subscribed anything');
  assert.strictEqual(await raw('/api/state'), 200, 'still up');
});

test('log ids stay unique after the log is trimmed or cleared', async () => {
  const { pg } = await setup();
  for (let i = 0; i < 3; i++) await post(api(pg, '/api/subscribe'), { eventType: `e${i}`, url: 'http://127.0.0.1:9/x' });
  await post(api(pg, '/api/clear'), {});
  await post(api(pg, '/api/subscribe'), { eventType: 'e9', url: 'http://127.0.0.1:9/x' });
  assert.deepStrictEqual((await state(pg)).log.map(e => e.id), [4]);
});
