// Runs the shared fixtures in ../../fixtures. `dotnet run --project dotnet/Parspec.Events.Tests`
using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Logging;
using Parspec.Events;
using Parspec.Events.AspNetCore;

var fx = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../fixtures"));
JsonArray Load(string name) => JsonNode.Parse(File.ReadAllText(Path.Combine(fx, name)))!.AsArray();
const string Base = "https://pm.example/platform-api/api/v1/";
int pass = 0, fail = 0;

async Task Check(string name, Func<Task> body)
{
    try { await body(); pass++; Console.WriteLine($"ok   {name}"); }
    catch (Exception e) { fail++; Console.WriteLine($"FAIL {name}: {e.Message}"); }
}
void Assert(bool cond, string what) { if (!cond) throw new Exception(what); }

foreach (var c in Load("signatures.json"))
{
    await Check($"signature: {c!["name"]}", () =>
    {
        var key = File.ReadAllText(Path.Combine(fx, "keys", (string)c["key"]!));
        var raw = Encoding.UTF8.GetBytes((string)c["body"]!);
        var sig = (string)c["signature"]!;
        var valid = (bool)c["valid"]!;
        Assert(Signature.Verify(raw, sig, key) == valid, $"Verify should be {valid}");
        if (valid && c["envelope"] is null)
        {
            var p = Signature.ParseEvent(raw, sig, key, "idem-1");
            Assert(p.TransactionId == p.Event.GetProperty("eventTransactionID").GetString(), "transaction id");
            Assert(p.IdempotencyKey == "idem-1", "idempotency key");
        }
        else
        {
            Exception? thrown = null;
            try { Signature.ParseEvent(raw, sig, key); } catch (Exception e) { thrown = e; }
            Assert(valid ? thrown is EventException : thrown is SignatureException,
                $"ParseEvent should throw {(valid ? "EventException" : "SignatureException")}, threw {thrown?.GetType().Name ?? "nothing"}");
        }
        return Task.CompletedTask;
    });
}

foreach (var c in Load("callbacks.json"))
{
    await Check($"callback: {c!["name"]}", async () =>
    {
        var handler = new FakeHandler(c["response"] is JsonNode resp ? [resp] : []);
        var client = new ParspecClient("k", baseUrl: Base, http: new HttpClient(handler));
        var evt = c["event"]!;
        var txid = (string)evt["eventTransactionID"]!;
        var cb = (string?)evt["callback_url"];
        var run = (string)c["call"]! == "error"
            ? client.FailAsync(txid, cb, (string)c["message"]!)
            : client.CallbackAsync(txid, cb, c["fields"]!.AsObject().ToDictionary(kv => kv.Key, kv => (object?)(string?)kv.Value));
        var exp = c["expect"]!;
        if (exp["error"] is JsonNode err)
        {
            var status = 0;
            try { await run; } catch (ParspecApiException e) { status = e.Status; }
            Assert(status == (int)err, $"should throw with status {err}, got {status}");
        }
        else await run;
        if (exp["method"] is null) { Assert(handler.Calls.Count == 0, "no request may be sent"); return; }
        Assert(handler.Calls.Count == 1, "one request");
        var got = handler.Calls[0];
        Assert(got.Method == (string)exp["method"]!, $"method {got.Method}");
        Assert(got.Url == (string)exp["url"]!, $"url {got.Url}");
        Assert(JsonNode.DeepEquals(got.Body, exp["body"]), $"body {got.Body}");
        Assert(got.ApiKey == "k", "x-api-key");
    });
}

foreach (var c in Load("subscribe.json"))
{
    await Check($"subscribe: {c!["name"]}", async () =>
    {
        var exchange = c["exchange"]!.AsArray();
        var handler = new FakeHandler(exchange.Select(x => x!["response"]!).ToList());
        var client = new ParspecClient("k", baseUrl: Base, http: new HttpClient(handler));
        var a = c["args"]!;
        var exp = c["expect"]!;
        var run = client.SubscribeAsync((string)a["eventType"]!, (int)a["version"]!, (string)a["webhookUrl"]!);
        if (exp["error"] is JsonNode err)
        {
            var status = 0;
            try { await run; } catch (ParspecApiException e) { status = e.Status; }
            Assert(status == (int)err, $"should throw with status {err}, got {status}");
        }
        else
        {
            var r = await run;
            Assert(r.PublicKey == (string)exp["publicKey"]! && r.Replaced == (int)exp["replaced"]!, $"result {r}");
        }
        Assert(handler.Calls.Count == exchange.Count, $"request count {handler.Calls.Count}");
        for (var i = 0; i < exchange.Count; i++)
        {
            var want = exchange[i]!["request"]!;
            var got = handler.Calls[i];
            Assert(got.Method == (string)want["method"]! && got.Url == Base + (string)want["path"]! && JsonNode.DeepEquals(got.Body, want["body"]),
                $"request {i}: {got.Method} {got.Url} {got.Body}");
        }
    });
}

await Check("client: constructor validation, environments, trailing slash", async () =>
{
    var threw = 0;
    try { _ = new ParspecClient(""); } catch (ArgumentException) { threw++; }
    try { _ = new ParspecClient("k", environment: "nowhere"); } catch (ArgumentException) { threw++; }
    Assert(threw == 2, "constructor validation");
    var handler = new FakeHandler([]);
    await new ParspecClient("k", environment: "sandbox", http: new HttpClient(handler)).CallbackAsync("t", null);
    await new ParspecClient("k", baseUrl: Base.TrimEnd('/'), http: new HttpClient(handler)).CallbackAsync("t", null);
    Assert(handler.Calls[0].Url == "https://platform-sandbox.parspec.io/platform-api/api/v1/integrations/events/callback", handler.Calls[0].Url);
    Assert(handler.Calls[1].Url == Base + "integrations/events/callback", handler.Calls[1].Url);
});

await Check("client: timeout raises status 0; caller cancellation propagates", async () =>
{
    var slow = new HttpClient(new HangingHandler());
    var status = -1;
    try { await new ParspecClient("k", baseUrl: Base, http: slow, timeout: TimeSpan.FromMilliseconds(50)).CallbackAsync("t", null); }
    catch (ParspecApiException e) { status = e.Status; }
    Assert(status == 0, $"timeout status {status}");
    using var cts = new CancellationTokenSource(50);
    var cancelled = false;
    try { await new ParspecClient("k", baseUrl: Base, http: slow).CallbackAsync("t", null, null, cts.Token); }
    catch (OperationCanceledException) { cancelled = true; }
    Assert(cancelled, "caller's cancellation should surface as OperationCanceledException");
});

await Check("unsubscribe: an explicit version clears only that version", async () =>
{
    var handler = new FakeHandler([]);
    var r = await new ParspecClient("k", baseUrl: Base, http: new HttpClient(handler)).UnsubscribeAsync("quote.created", 2);
    Assert(r.Count == 1 && r[0] == (2, 200), $"result {string.Join(",", r)}");
    Assert(JsonNode.DeepEquals(handler.Calls[0].Body, JsonNode.Parse("{\"event_type\":\"quote.created\",\"event_version\":2}")), "body");
});

foreach (var c in Load("receiver.json"))
{
    await Check($"receiver: {c!["name"]}", async () =>
    {
        var statuses = (c["callbackResponses"]?.AsArray() ?? []).Select(x => JsonNode.Parse($"{{\"status\":{(int)x!},\"body\":{{}}}}")!).ToList();
        var handler = new FakeHandler(statuses);
        var client = new ParspecClient("k", baseUrl: Base, http: new HttpClient(handler));
        var stores = new TestStores(c, fx);
        var receiver = new Receiver(client, stores, stores);
        var calls = new List<string>();
        foreach (var (eventType, behaviours) in c["handlers"]!.AsObject())
        {
            var list = behaviours!.AsArray();
            var n = 0;
            receiver.On(eventType, (evt, ctx) =>
            {
                calls.Add($"{ctx.EventType}|{ctx.TransactionId}");
                var b = list[Math.Min(n++, list.Count - 1)]!;
                if (b["throw"] is JsonNode t) throw new InvalidOperationException((string)t!);
                var ret = b["return"];
                IDictionary<string, object?>? fields = ret is JsonObject o ? o.ToDictionary(kv => kv.Key, kv => (object?)kv.Value?.DeepClone()) : null;
                return Task.FromResult(fields);
            });
        }
        var got = new List<int>();
        foreach (var d in c["deliveries"]!.AsArray())
            got.Add(await receiver.HandleAsync(Encoding.UTF8.GetBytes((string)d!["body"]!), (string)d["signature"]!));
        var exp = c["expect"]!;
        var wantStatus = c["deliveries"]!.AsArray().Select(d => (int)d!["status"]!).ToList();
        Assert(got.SequenceEqual(wantStatus), $"statuses {string.Join(",", got)}");
        var wantCalls = exp["calls"]!.AsArray().Select(x => $"{x!["eventType"]}|{x["transactionId"]}").ToList();
        Assert(calls.SequenceEqual(wantCalls), $"calls {string.Join(",", calls)}");
        var sent = handler.Calls.Select(x => x.Body).ToList();
        var wantCallbacks = exp["callbacks"]!.AsArray();
        Assert(sent.Count == wantCallbacks.Count && sent.Zip(wantCallbacks).All(p => JsonNode.DeepEquals(p.First, p.Second)), $"callbacks {string.Join(" ", sent)}");
        Assert(stores.Done.OrderBy(x => x).SequenceEqual(exp["done"]!.AsArray().Select(x => (string)x!).OrderBy(x => x)), "done");
        Assert(stores.Processing.OrderBy(x => x).SequenceEqual(exp["processing"]!.AsArray().Select(x => (string)x!).OrderBy(x => x)), "processing");
    });
}

await Check("receiver: subscribe saves keys to a writable store and returns them", async () =>
{
    var handler = new FakeHandler([
        JsonNode.Parse("{\"status\":200,\"body\":{}}")!, JsonNode.Parse("{\"status\":200,\"body\":{}}")!, JsonNode.Parse("{\"status\":200,\"body\":{\"publicKey\":\"KEY-A\"}}")!]);
    var keys = new MemoryKeyStore();
    var receiver = new Receiver(new ParspecClient("k", baseUrl: Base, http: new HttpClient(handler)), keys)
        .On("inventory.fetchPrice", (e, c) => Task.FromResult<IDictionary<string, object?>?>(null), version: 2);
    var minted = await receiver.SubscribeAsync("https://erp.example/hook");
    Assert(minted["inventory.fetchPrice"] == "KEY-A", "returned");
    Assert((await keys.GetAsync())["inventory.fetchPrice"] == "KEY-A", "saved");
    Assert((int)handler.Calls[2].Body!["event_version"]! == 2, "version");
});

await Check("receiver: MemoryTransactionStore claims once and expires stale claims", async () =>
{
    var t = new MemoryTransactionStore(TimeSpan.FromMilliseconds(20));
    Assert(await t.ClaimAsync("a") && !await t.ClaimAsync("a"), "claim once");
    await Task.Delay(40);
    Assert(await t.ClaimAsync("a"), "stale claim taken over");
    await t.DoneAsync("a");
    Assert(!await t.ClaimAsync("a"), "done");
});

await Check("client: local and uat environments", async () =>
{
    var handler = new FakeHandler([]);
    await new ParspecClient("k", environment: "local", http: new HttpClient(handler)).CallbackAsync("t", null);
    await new ParspecClient("k", environment: "uat", http: new HttpClient(handler)).CallbackAsync("t", null);
    Assert(handler.Calls[0].Url == "http://127.0.0.1:4800/platform-api/api/v1/integrations/events/callback", handler.Calls[0].Url);
    Assert(handler.Calls[1].Url == "https://uat-platform.parspec.io/platform-api/api/v1/integrations/events/callback", handler.Calls[1].Url);
});

await Check("receiver: MapParspecWebhook answers PM before the function runs, over real HTTP", async () =>
{
    var c = Load("receiver.json")[0]!;
    var d = c["deliveries"]!.AsArray()[0]!;
    var callbacks = new FakeHandler([]);
    var stores = new TestStores(c, fx);
    var gate = new TaskCompletionSource();
    var receiver = new Receiver(new ParspecClient("k", baseUrl: Base, http: new HttpClient(callbacks)), stores, stores)
        .On("inventory.fetchPrice", async (e, ctx) => { await gate.Task; return null; });
    var builder = WebApplication.CreateSlimBuilder();
    builder.WebHost.UseUrls("http://127.0.0.1:0");
    builder.Logging.ClearProviders();
    await using var app = builder.Build();
    app.MapParspecWebhook("/parspec/webhook", receiver);
    await app.StartAsync();
    var url = app.Urls.First() + "/parspec/webhook";
    using var http = new HttpClient();
    async Task<int> Post(string body)
    {
        using var req = new HttpRequestMessage(HttpMethod.Post, url) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
        req.Headers.Add("X-Signature", (string)d["signature"]!);
        return (int)(await http.SendAsync(req)).StatusCode;
    }
    Assert(await Post((string)d["body"]!) == 200, "answered while the function is still waiting");
    Assert(callbacks.Calls.Count == 0, "no callback before the function returns");
    gate.SetResult();
    for (var i = 0; i < 100 && callbacks.Calls.Count == 0; i++) await Task.Delay(10);
    Assert((string?)callbacks.Calls[0].Body!["EventStatus"] == "success", "callback sent");
    Assert(await Post((string)d["body"]!) == 200, "duplicate acknowledged");
    Assert(await Post(((string)d["body"]!).Replace("\"data\":", "\"data\" :")) == 401, "tampered");
    Assert((int)(await http.GetAsync(url)).StatusCode == 405, "GET is not mapped");
    await app.StopAsync();
});

Console.WriteLine($"{pass} passed, {fail} failed");
return fail == 0 ? 0 : 1;

record Call(string Method, string Url, JsonNode? Body, string? ApiKey);

// Records requests and replays canned responses (200 {} when the script runs out).
class FakeHandler(List<JsonNode> responses) : HttpMessageHandler
{
    public List<Call> Calls { get; } = [];
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage req, CancellationToken ct)
    {
        var body = req.Content is null ? null : JsonNode.Parse(await req.Content.ReadAsStringAsync(ct));
        Calls.Add(new Call(req.Method.Method, req.RequestUri!.ToString(), body, req.Headers.TryGetValues("x-api-key", out var v) ? v.First() : null));
        var r = Calls.Count <= responses.Count ? responses[Calls.Count - 1] : JsonNode.Parse("""{"status":200,"body":{}}""")!;
        if (r["network"] is not null) throw new HttpRequestException("connection refused");
        return new HttpResponseMessage((HttpStatusCode)(int)r["status"]!) { Content = new StringContent(r["body"]!.ToJsonString()) };
    }
}

// Never answers: only cancellation ends the request.
class HangingHandler : HttpMessageHandler
{
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage req, CancellationToken ct)
    {
        await Task.Delay(Timeout.Infinite, ct);
        throw new InvalidOperationException("unreachable");
    }
}

// A store the test writes itself, as a developer would: read-only keys (like env vars) and a transaction set.
class TestStores : IKeyStore, ITransactionStore
{
    readonly Dictionary<string, string> _keys;
    public HashSet<string> Processing { get; }
    public HashSet<string> Done { get; }

    public TestStores(JsonNode c, string fx)
    {
        _keys = c["keys"]!.AsObject().ToDictionary(kv => kv.Key, kv => File.ReadAllText(Path.Combine(fx, "keys", (string)kv.Value!)));
        Processing = (c["processing"]?.AsArray() ?? []).Select(x => (string)x!).ToHashSet();
        Done = (c["done"]?.AsArray() ?? []).Select(x => (string)x!).ToHashSet();
    }

    public ValueTask<IReadOnlyDictionary<string, string>> GetAsync(CancellationToken ct = default) => ValueTask.FromResult<IReadOnlyDictionary<string, string>>(_keys);
    public ValueTask<bool> ClaimAsync(string t, CancellationToken ct = default) => ValueTask.FromResult(!Processing.Contains(t) && !Done.Contains(t) && Processing.Add(t));
    public ValueTask DoneAsync(string t, CancellationToken ct = default) { Processing.Remove(t); Done.Add(t); return ValueTask.CompletedTask; }
    public ValueTask ReleaseAsync(string t, CancellationToken ct = default) { Processing.Remove(t); return ValueTask.CompletedTask; }
}
