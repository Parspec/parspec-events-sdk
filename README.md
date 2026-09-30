# Parspec SDK: PM events

Small libraries for receiving Parspec PM webhook events in your own service: subscribe, verify, and call back. One implementation per language, all tested against the same fixtures.

| Language | Path | Dependencies |
|---|---|---|
| Node 18+ | `node/` | none |
| Python 3.9+ | `python/` | `cryptography` |
| .NET 8+ | `dotnet/` | none |
| Java 17+ | `java/` | none |

The Workato connector (`workato-connector`) implements the same protocol for Workato recipes.

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

## Node

```js
const { createClient, parseEvent } = require('@parspec/events');
const client = createClient({ apiKey: process.env.PARSPEC_API_KEY, environment: 'sandbox' });

const { publicKey } = await client.subscribe('tandemOrder.publishToErp', 1, 'https://your-host/webhook');

// in your webhook handler, with the raw body:
const { event, transactionId } = parseEvent(rawBody, req.headers, publicKey);  // throws SignatureError
await client.callback(event, { orderId: 'SO-123' });
// or: await client.fail(event, 'Credit check failed');
```

A runnable receiver is in `node/example-server.js`.

## Python

```python
from parspec_events import Client, parse_event

client = Client(api_key, environment="sandbox")
public_key = client.subscribe("tandemOrder.publishToErp", 1, "https://your-host/webhook")["publicKey"]

parsed = parse_event(raw_body, headers, public_key)  # raises SignatureError
client.callback(parsed["event"], {"orderId": "SO-123"})
# or: client.fail(parsed["event"], "Credit check failed")
```

## .NET

```csharp
using Parspec.Events;

var client = new ParspecClient(apiKey, environment: "sandbox");
var sub = await client.SubscribeAsync("tandemOrder.publishToErp", 1, "https://your-host/webhook");

// in your webhook handler, with the raw body:
var evt = Signature.ParseEvent(rawBody, Request.Headers["X-Signature"], sub.PublicKey, Request.Headers["Idempotency-Key"]);  // throws SignatureException
await client.CallbackAsync(evt, new Dictionary<string, object?> { ["orderId"] = "SO-123" });
// or: await client.FailAsync(evt, "Credit check failed");
```

## Java (Spring Boot or plain Java)

```java
import com.parspec.events.*;

ParspecClient client = new ParspecClient(apiKey, "sandbox");
String publicKey = client.subscribe("tandemOrder.publishToErp", 1, "https://your-host/webhook").publicKey();

// Spring Boot: take the body as byte[] so the signature is checked against the exact bytes PM sent.
@PostMapping("/webhook")
public ResponseEntity<Void> webhook(@RequestBody byte[] body,
                                    @RequestHeader(value = "X-Signature", required = false) String sig,
                                    @RequestHeader(value = "Idempotency-Key", required = false) String idem) {
    Signature.ParsedEvent evt;
    try { evt = Signature.parseEvent(body, sig, publicKey, idem); }
    catch (Signature.SignatureException e) { return ResponseEntity.status(401).build(); }
    // hand evt to a background worker, then:
    //   client.callback(evt, Map.of("orderId", "SO-123"));   or   client.fail(evt, "Credit check failed");
    return ResponseEntity.ok().build();
}
```

`evt.event()` is the parsed envelope as maps and lists. To bind it to your own classes, parse `body` again with Jackson after verifying.

## Tests

```
(cd node && node --test test.js)
(cd python && python3 -m unittest)
dotnet run --project dotnet/Parspec.Events.Tests
(cd java && javac --release 17 -d out $(find src -name '*.java') && java -cp out com.parspec.events.FixturesTest)
```

Run from the repo root.

All four run the files in `fixtures/`:

- `signatures.json`: signed bodies and whether each should verify. Covers tampered bodies, re-serialized JSON, a stale key, and empty or malformed signatures.
- `callbacks.json`: callback inputs and the exact request each SDK must send.
- `subscribe.json`: scripted request/response exchanges for subscribe, including the conflict retry.

A new language is done when it passes all three. `node fixtures/generate.js` regenerates the signature and callback fixtures with fresh test keys.
