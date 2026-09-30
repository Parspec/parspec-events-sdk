# Parspec PM events: C# / .NET

Subscribe to Parspec PM events, verify webhook signatures, and send callbacks. .NET 8+, no dependencies.

Add `Parspec.Events/` to your solution (`dotnet add reference path/to/Parspec.Events`), or copy `ParspecEvents.cs` into your project. For the ASP.NET Core endpoint, also add `Parspec.Events.AspNetCore/`; the core package does not depend on ASP.NET Core.

```csharp
using Parspec.Events;

var client = new ParspecClient(apiKey, environment: "sandbox");
var sub = await client.SubscribeAsync("salesOrder.publishToErp", 1, "https://your-host/webhook");

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
using Parspec.Events;
using Parspec.Events.AspNetCore;   // MapParspecWebhook

// Read-only key store from configuration (env vars, appsettings, Key Vault via IConfiguration).
sealed class ConfigKeys(IConfiguration config) : IKeyStore
{
    public ValueTask<IReadOnlyDictionary<string, string>> GetAsync(CancellationToken ct = default) =>
        ValueTask.FromResult<IReadOnlyDictionary<string, string>>(
            config.GetSection("Parspec:Keys").GetChildren().ToDictionary(k => k.Key, k => k.Value!));
}

var receiver = new Receiver(new ParspecClient(apiKey, environment: "sandbox"),
        new ConfigKeys(builder.Configuration), myTransactions)   // ITransactionStore, e.g. Postgres or Redis
    .On("salesOrder.publishToErp", async (evt, ctx, ct) =>
    {
        var so = await erp.CreateSalesOrderAsync(evt.Event.GetProperty("data"), idempotencyKey: ctx.TransactionId, ct);
        return new Dictionary<string, object?> { ["orderId"] = so.Id };   // throw to send an error callback
    });

var newKeys = await receiver.SubscribeAsync("https://erp.example/parspec/webhook");   // store these

// ASP.NET Core (Parspec.Events.AspNetCore): the receiver reads the raw body, answers PM, then runs your function.
app.MapParspecWebhook("/parspec/webhook", receiver);
```

`environment: "local"` points at the playground; `"sandbox"`, `"uat"` and `"production"` at PM. In another pipeline, `receiver.HandleHttpAsync(httpContext)` does the same; outside ASP.NET Core, call `AcceptAsync`, answer with `Status`, then await `Process()`.

`MemoryKeyStore` and `MemoryTransactionStore` are the in-memory versions for development. Implement `IWritableKeyStore` if `SubscribeAsync` should save keys itself. `onError` is called when a handler or callback fails.

## Use as a git submodule

The `csharp` branch of this repo holds only this SDK, so it can be added to your project directly:

```
git submodule add -b csharp <repo-url> vendor/parspec-events
dotnet add reference vendor/parspec-events/csharp/Parspec.Events/Parspec.Events.csproj
dotnet add reference vendor/parspec-events/csharp/Parspec.Events.AspNetCore/Parspec.Events.AspNetCore.csproj   # ASP.NET Core endpoint
```

Pull updates with `git submodule update --remote`. Your project stays on the commit it has until you do.

## Tests

```
dotnet run --project csharp/Parspec.Events.Tests
```

Runs the shared cases in `fixtures/`.
