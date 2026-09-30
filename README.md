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

## How PM events work

**1. Subscribe** once per event type, with your PM API key in `x-api-key`:

```
PUT {base}/integrations/events/subscribe
{ "event_type": "tandemOrder.publishToErp", "event_version": 1, "webhook_url": "https://your-host/webhook" }
```

- Subscribing doesn't update an existing subscription, and only one version per event can be active. Unsubscribe both versions first (`DELETE {base}/integrations/events/unsubscribe` with `event_type` and `event_version`). The SDK does this for you.
- An org can hold more than one subscription for the same event. The subscribe then fails with "an active subscription already exists". The SDK clears the version the error names and retries.
- Every subscribe returns a new `publicKey`. Store it; deliveries are signed with it from then on. If you cache keys, reload them after a resubscribe, or verification for that event will fail.

**2. Receive.** PM POSTs to your `webhook_url`:

```json
{ "eventTransactionID": "uuid", "callback_url": "integrations/events/callback", "data": { ... } }
```

Headers: `X-Signature` (base64 RSA-SHA256 over the raw body) and, when present, `Idempotency-Key`.

**3. Verify** the signature against the raw request bytes before doing anything else. Re-serialized JSON will not verify. Reject anything that fails.

**4. Acknowledge** with a 200 right away, then do the work.

**5. Deduplicate** on `eventTransactionID`. The same event can arrive more than once. Anything you send back, such as an order number, must stay the same across repeat deliveries: PM rejects duplicate orders.

**6. Call back** once per event:

```
POST {base}/{callback_url}
{ "EventTransactionID": "...", "EventStatus": "success", "orderId": "SO-123" }
```

On failure, send `"EventStatus": "error"` with an `errorMessage`. PM shows that message to the user (a failed credit check, for example).

**Base URLs** (`{base}`):

| Environment | URL |
|---|---|
| production | `https://platform.parspec.io/platform-api/api/v1/` |
| sandbox | `https://platform-sandbox.parspec.io/platform-api/api/v1/` |
| preprod | `https://uat-platform.parspec.io/platform-api/api/v1/` |

Event types, versions and payloads: developer.parspec.io.
