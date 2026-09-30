// Minimal receiver built on the SDK.
//
// Against the local playground (node harness/playground.js):
//   PARSPEC_BASE_URL=http://localhost:4800/platform-api/api/v1/ PARSPEC_API_KEY=dev \
//   PARSPEC_EVENTS=tandemOrder.publishToErp:1,inventory.fetchPrice:2 node example-server.js
//
// Against PM: PARSPEC_ENV=sandbox, your API key, and PUBLIC_URL set to a public URL that reaches PORT.
// PARSPEC_EVENTS subscribes each event at startup (type:version) and keeps the keys in memory.
const http = require('http');
const { createClient, parseEvent, verify } = require('./index.js');

const port = Number(process.env.PORT || 3000);
const publicUrl = (process.env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/+$/, '');
const client = createClient({ apiKey: process.env.PARSPEC_API_KEY, environment: process.env.PARSPEC_ENV || 'sandbox', baseUrl: process.env.PARSPEC_BASE_URL });
const keys = {};          // eventType -> publicKey
const seen = new Set();   // use your database in production: dedup must survive restarts

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => handle(Buffer.concat(chunks), req, res).catch(e => {
    console.error(`request failed: ${e.message}`);
    if (!res.headersSent) res.writeHead(400).end();
  }));
});

async function handle(raw, req, res) {
  // Several events can share one URL; the key that verifies identifies the event.
  const match = Object.entries(keys).find(([, k]) => verify(raw, req.headers['x-signature'], k));
  if (!match) { console.log('rejected: signature did not verify'); res.writeHead(401).end(); return; }
  const [eventType, key] = match;
  const { event, transactionId } = parseEvent(raw, req.headers, key);
  res.writeHead(200).end();   // acknowledge first, work after
  if (seen.has(transactionId)) { console.log(`duplicate ${eventType} ${transactionId}, skipped`); return; }
  seen.add(transactionId);
  try {
    const orderId = `SO-${transactionId.slice(0, 8)}`;   // your ERP call goes here
    await client.callback(event, { orderId });
    console.log(`${eventType} ${transactionId} → callback sent (orderId ${orderId})`);
  } catch (e) {
    console.error(`${eventType} ${transactionId} failed: ${e.message}`);
    await client.fail(event, e.message).catch(console.error);
  }
}

server.listen(port, async () => {
  console.log(`receiver on ${publicUrl}/webhook`);
  for (const spec of (process.env.PARSPEC_EVENTS || '').split(',').filter(Boolean)) {
    const [eventType, version = '1'] = spec.split(':');
    try {
      keys[eventType] = (await client.subscribe(eventType, Number(version), `${publicUrl}/webhook`)).publicKey;
      console.log(`subscribed ${eventType} v${version}`);
    } catch (e) { console.error(`subscribe ${eventType} failed: ${e.message}`); }
  }
});
