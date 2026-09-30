// Minimal receiver built on the SDK's Receiver.
//
// Against the local playground (node harness/playground.js):
//   PARSPEC_BASE_URL=http://127.0.0.1:4800/platform-api/api/v1/ PARSPEC_API_KEY=dev \
//   PARSPEC_EVENTS=tandemOrder.publishToErp:1,inventory.fetchPrice:2 node example-server.js
//
// Against PM: PARSPEC_ENV=sandbox, your API key, and PUBLIC_URL set to a public URL that reaches PORT.
// Each event in PARSPEC_EVENTS (type:version) gets a demo handler and is subscribed at startup. Keys and
// seen transactions live in memory here; in production, pass your own `keys` and `transactions` stores.
const http = require('http');
const { createClient, createReceiver } = require('./index.js');

const port = Number(process.env.PORT || 3000);
const publicUrl = (process.env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/+$/, '');
const client = createClient({ apiKey: process.env.PARSPEC_API_KEY, environment: process.env.PARSPEC_ENV || 'sandbox', baseUrl: process.env.PARSPEC_BASE_URL });
const receiver = createReceiver({ client, onError: (e, ctx) => console.error(`${ctx.eventType} ${ctx.transactionId} failed: ${e.message}`) });

for (const spec of (process.env.PARSPEC_EVENTS || 'tandemOrder.publishToErp:1').split(',').filter(Boolean)) {
  const [eventType, version = '1'] = spec.split(':');
  receiver.on(eventType, async (event, ctx) => {
    // Your ERP call goes here. Pass ctx.transactionId as its idempotency key: if the callback fails,
    // PM redelivers and this runs again.
    const orderId = `SO-${ctx.transactionId.slice(0, 8)}`;
    console.log(`${eventType} ${ctx.transactionId} → callback with orderId ${orderId}`);
    return { orderId };
  }, { version: Number(version) });
}

const MAX_BODY = 5 << 20;
http.createServer((req, res) => {
  const chunks = [];
  let size = 0;
  req.on('data', c => { size += c.length; if (size > MAX_BODY) req.destroy(); else chunks.push(c); });
  req.on('end', async () => {
    try {
      const { status, process } = await receiver.accept(Buffer.concat(chunks), req.headers);
      res.writeHead(status).end();   // answer PM first, then do the work
      if (status === 401) console.log('rejected: signature did not verify');
      await process();
    } catch (e) {
      console.error(`request failed: ${e.message}`);
      if (!res.headersSent) res.writeHead(500).end();
    }
  });
}).listen(port, async () => {
  console.log(`receiver on ${publicUrl}/webhook`);
  try {
    for (const eventType of Object.keys(await receiver.subscribe(`${publicUrl}/webhook`))) console.log(`subscribed ${eventType}`);
  } catch (e) { console.error(`subscribe failed: ${e.message}`); }
});
