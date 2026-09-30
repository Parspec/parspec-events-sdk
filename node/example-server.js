// Minimal receiver built on the SDK's Receiver.
//
// Against the local playground (node harness/playground.js):
//   PARSPEC_ENV=local PARSPEC_API_KEY=dev PARSPEC_EVENTS=tandemOrder.publishToErp:1,inventory.fetchPrice:2 node example-server.js
//
// Against PM: PARSPEC_ENV=sandbox (or uat, production), your API key, and PUBLIC_URL set to a public HTTPS URL
// that reaches PORT. Each event in PARSPEC_EVENTS (type:version) gets a demo handler and is subscribed at startup.
// Keys and seen transactions live in memory here; in production, pass your own `keys` and `transactions` stores.
const http = require('http');
const { createClient, createReceiver } = require('./index.js');

const port = Number(process.env.PORT || 3000);
const publicUrl = (process.env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/+$/, '');
const client = createClient({ apiKey: process.env.PARSPEC_API_KEY, environment: process.env.PARSPEC_ENV || 'sandbox', baseUrl: process.env.PARSPEC_BASE_URL });
const receiver = createReceiver({ client, onError: (e, ctx) => console.error(`${ctx.eventType || 'webhook'} ${ctx.transactionId || ''} failed: ${e.message}`) });

for (const spec of (process.env.PARSPEC_EVENTS || 'tandemOrder.publishToErp:1').split(',').filter(Boolean)) {
  const [eventType, version = '1'] = spec.split(':');
  receiver.on(eventType, async (event, ctx) => {
    // Your ERP call goes here. Return the callback fields for this event (PROTOCOL.md, "Callbacks, event
    // by event"). Pass ctx.transactionId to your ERP as its idempotency key.
    const orderId = `SO-${ctx.transactionId.slice(0, 8)}`;
    console.log(`${eventType} ${ctx.transactionId} → callback with orderId ${orderId}`);
    return { orderId };
  }, { version: Number(version) });
}

http.createServer(receiver.handler()).listen(port, async () => {
  console.log(`receiver on ${publicUrl}/webhook`);
  try {
    for (const eventType of Object.keys(await receiver.subscribe(`${publicUrl}/webhook`))) console.log(`subscribed ${eventType}`);
  } catch (e) { console.error(`subscribe failed: ${e.message}`); }
});
