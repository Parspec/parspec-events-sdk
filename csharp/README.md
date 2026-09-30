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
