# Parspec PM events: C# / .NET

Subscribe to Parspec PM events, verify webhook signatures, and send callbacks. .NET 8+, no dependencies.

Add `Parspec.Events/` to your solution (`dotnet add reference path/to/Parspec.Events`), or copy `ParspecEvents.cs` into your project.

```csharp
using Parspec.Events;

var client = new ParspecClient(apiKey, environment: "sandbox");
var sub = await client.SubscribeAsync("tandemOrder.publishToErp", 1, "https://your-host/webhook");

// ASP.NET Core minimal API: read the raw body so the signature is checked against the exact bytes PM sent.
app.MapPost("/webhook", async (HttpRequest req) =>
{
    using var ms = new MemoryStream();
    await req.Body.CopyToAsync(ms);
    ParsedEvent evt;
    try { evt = Signature.ParseEvent(ms.ToArray(), req.Headers["X-Signature"], sub.PublicKey, req.Headers["Idempotency-Key"]); }
    catch (SignatureException) { return Results.Unauthorized(); }
    // hand evt to a background worker, then:
    //   await client.CallbackAsync(evt, new Dictionary<string, object?> { ["orderId"] = "SO-123" });
    //   or: await client.FailAsync(evt, "Credit check failed");
    return Results.Ok();
});
```

`evt.Event` is a `JsonElement`. To bind it to your own classes, deserialize the same raw bytes with `System.Text.Json` after verifying.

## Tests

```
dotnet run --project csharp/Parspec.Events.Tests
```

Runs the shared cases in `fixtures/`.

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
