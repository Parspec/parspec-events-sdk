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

## Receiver

Register a function per event type; the receiver verifies, routes, deduplicates and calls back. How it works, and how to store keys and transactions in production: [PROTOCOL.md](../PROTOCOL.md#the-receiver-and-where-to-store-things).

```csharp
// Read-only key store from configuration (env vars, appsettings, Key Vault via IConfiguration).
sealed class ConfigKeys(IConfiguration config) : IKeyStore
{
    public ValueTask<IReadOnlyDictionary<string, string>> GetAsync(CancellationToken ct = default) =>
        ValueTask.FromResult<IReadOnlyDictionary<string, string>>(
            config.GetSection("Parspec:Keys").GetChildren().ToDictionary(k => k.Key, k => k.Value!));
}

var receiver = new Receiver(new ParspecClient(apiKey, environment: "sandbox"),
        new ConfigKeys(builder.Configuration), myTransactions)   // ITransactionStore, e.g. Postgres or Redis
    .On("tandemOrder.publishToErp", async (evt, ctx, ct) =>
    {
        var so = await erp.CreateSalesOrderAsync(evt.Event.GetProperty("data"), idempotencyKey: ctx.TransactionId, ct);
        return new Dictionary<string, object?> { ["orderId"] = so.Id };   // throw to send an error callback
    });

var newKeys = await receiver.SubscribeAsync("https://erp.example/parspec/webhook");   // store these

// ASP.NET Core: raw body, answer first, then process.
app.MapPost("/parspec/webhook", async (HttpRequest req) =>
{
    using var ms = new MemoryStream();
    await req.Body.CopyToAsync(ms);
    var r = await receiver.AcceptAsync(ms.ToArray(), req.Headers["X-Signature"], req.Headers["Idempotency-Key"]);
    _ = Task.Run(r.Process);   // or hand it to a background queue (IHostedService)
    return Results.StatusCode(r.Status);
});
```

`MemoryKeyStore` and `MemoryTransactionStore` are the in-memory versions for development. Implement `IWritableKeyStore` if `SubscribeAsync` should save keys itself. `onError` is called when a handler or callback fails.

## Use as a git submodule

The `csharp` branch of this repo holds only this SDK, so it can be added to your project directly:

```
git submodule add -b csharp <repo-url> vendor/parspec-events
dotnet add reference vendor/parspec-events/csharp/Parspec.Events/Parspec.Events.csproj
```

Pull updates with `git submodule update --remote`. Your project stays on the commit it has until you do.

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

`callback_url` is a path relative to the base URL; every delivery PM has sent uses `integrations/events/callback`. The API key goes with every callback, so the SDKs send it only to the configured PM host: an absolute `callback_url` on any other host is refused, and nothing is sent.

**Errors, the same in every SDK:**

- `verify` returns true or false and never throws, even for a missing, malformed or non-RSA key.
- `parseEvent` raises the signature error when the signature doesn't verify, and the event error when a signed body isn't a PM event (not JSON, not an object, no `eventTransactionID`).
- Every failed API call raises the SDK's API error, carrying the HTTP status. The status is `0` when there was no response (network failure, timeout) or the request was refused before sending.

**Base URLs** (`{base}`):

| Environment | URL |
|---|---|
| production | `https://platform.parspec.io/platform-api/api/v1/` |
| sandbox | `https://platform-sandbox.parspec.io/platform-api/api/v1/` |
| preprod | `https://uat-platform.parspec.io/platform-api/api/v1/` |

Event types, versions and payloads: developer.parspec.io.

## The receiver, and where to store things

Each SDK has a receiver. You register one function per event type, and it handles each delivery:

1. **Verify and route.** It finds the stored key that verifies the signature, which also identifies the event type, since several events can share one URL. No key verifies → 401.
2. **Parse and claim.** It parses the envelope and claims the `eventTransactionID`. A body that isn't a PM event → 400. Already done, or claimed by another worker → 200 and nothing else.
3. **Answer, then run.** It answers 200, then runs your function.
4. **Call back once.** Your function's return value becomes the success callback. If it throws, the SDK sends an error callback with the message.
5. **Settle the claim.** The transaction is marked done, or released so a redelivery retries. A failed callback also releases it.
6. **Events without a function** get a plain acknowledgement.

You decide where two kinds of state live. The SDK only needs a small interface for each.

**Keys**
- **Interface:** `get()` returns every event type's public key. An optional `set(eventType, key)` lets `subscribe()` save new keys.
- **They aren't secret.** These are the *public* keys PM verifies with: anyone may read them, so env vars, a config file, a database row or a keychain are all fine. What must never leak is your API key, which the SDK only ever sends to PM.
- **Update them on every subscribe.** Each subscribe mints a new key, so every server needs the new one.
- **Read-only stores:** with env vars, omit `set()`. `subscribe()` returns the new keys, and you update the environment and restart.

**Transactions (duplicate protection)**
- **Interface:** `claim(txid)` atomically returns false when the transaction is done or another worker holds it; `done(txid)`; `release(txid)`.
- **Shared and atomic.** In production this must be shared by every server and survive restarts. The in-memory store is for development only.
- **Leases.** A claim that is never settled, because the worker died, must expire, so a redelivery can take it over. The in-memory stores use 15 minutes.

PostgreSQL:

```sql
create table parspec_transactions (
  txid text primary key,
  status text not null,              -- 'processing' or 'done'
  claimed_at timestamptz not null default now()
);

-- claim: true when a row comes back. Takes over a stale claim; never touches a done one.
insert into parspec_transactions (txid, status) values ($1, 'processing')
on conflict (txid) do update set claimed_at = now()
  where parspec_transactions.status = 'processing'
    and parspec_transactions.claimed_at < now() - interval '15 minutes'
returning txid;

-- done
update parspec_transactions set status = 'done' where txid = $1;

-- release
delete from parspec_transactions where txid = $1 and status = 'processing';
```

Redis:
- **claim:** `SET parspec:tx:<txid> processing NX PX 900000` returns `OK`. The expiry is the lease.
- **done:** `SET parspec:tx:<txid> done EX 2592000`. Keep done ids for about as long as PM might redeliver; 30 days here.
- **release:** `DEL parspec:tx:<txid>`.

**Make handlers idempotent.** A redelivery after a failed callback runs your function again. Pass the context's transaction id to your ERP as its idempotency key, so the same event never creates two orders. Any order number you return must be the same on every run.
