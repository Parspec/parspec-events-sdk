# Parspec PM events: Node

Subscribe to Parspec PM events, verify webhook signatures, and send callbacks. Node 18+, no dependencies.

Copy `index.js` into your project, or install this folder as a package (`@parspec/events`).

```js
const { createClient, parseEvent } = require('@parspec/events');   // or require('./index.js')
const client = createClient({ apiKey: process.env.PARSPEC_API_KEY, environment: 'sandbox' });

const { publicKey } = await client.subscribe('tandemOrder.publishToErp', 1, 'https://your-host/webhook');

// in your webhook handler, with the raw body (a Buffer, not parsed JSON):
const { event, transactionId } = parseEvent(rawBody, req.headers, publicKey);  // throws SignatureError
await client.callback(event, { orderId: 'SO-123' });
// or: await client.fail(event, 'Credit check failed');
```

In Express, use `express.raw({ type: 'application/json' })` on the webhook route so `req.body` is the raw Buffer.

A runnable receiver is in `example-server.js`.

## Receiver

Register a function per event type; the receiver verifies, routes, deduplicates and calls back. How it works, and how to store keys and transactions in production: [PROTOCOL.md](../PROTOCOL.md#the-receiver-and-where-to-store-things).

```js
const { createClient, createReceiver } = require('@parspec/events');

const receiver = createReceiver({
  client: createClient({ apiKey: process.env.PARSPEC_API_KEY, environment: 'sandbox' }),
  keys: { get: () => JSON.parse(process.env.PARSPEC_KEYS || '{}') },   // read-only: env vars
  transactions: myTransactions,                                          // claim / done / release, e.g. Postgres or Redis
});

receiver.on('tandemOrder.publishToErp', async (event, ctx) => {
  const so = await erp.createSalesOrder(event.data, { idempotencyKey: ctx.transactionId });
  return { orderId: so.id };        // the success callback; throw to send an error callback
});
receiver.on('inventory.fetchPrice', priceHandler, { version: 2 });

const newKeys = await receiver.subscribe('https://erp.example/parspec/webhook');   // store these: PARSPEC_KEYS

// Express: raw body, answer first, then process.
app.post('/parspec/webhook', express.raw({ type: '*/*' }), async (req, res) => {
  const { status, process } = await receiver.accept(req.body, req.headers);
  res.sendStatus(status);
  await process();
});
```

The keys store can be anything with `get()` (and `set()` if `subscribe()` should save keys itself). `memoryKeys()` and `memoryTransactions()` are the in-memory versions for development. `onError(err, ctx)` is called when a handler or callback fails.

## Use as a git submodule

The `node` branch of this repo holds only this SDK, so it can be added to your project directly:

```
git submodule add -b node <repo-url> vendor/parspec-events
npm install ./vendor/parspec-events/node
```

Pull updates with `git submodule update --remote`. Your project stays on the commit it has until you do.

## Tests

```
cd node && node --test test.js
```

Runs the shared cases in `../fixtures/`.
