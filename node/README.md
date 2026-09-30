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

## Tests

```
cd node && node --test test.js
```

Runs the shared cases in `../fixtures/`.
