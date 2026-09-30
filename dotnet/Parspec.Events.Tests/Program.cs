// Runs the shared fixtures in ../../fixtures. `dotnet run --project dotnet/Parspec.Events.Tests`
using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Parspec.Events;

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
        if (valid)
        {
            var p = Signature.ParseEvent(raw, sig, key, "idem-1");
            Assert(p.TransactionId == p.Event.GetProperty("eventTransactionID").GetString(), "transaction id");
            Assert(p.IdempotencyKey == "idem-1", "idempotency key");
        }
        else
        {
            var threw = false;
            try { Signature.ParseEvent(raw, sig, key); } catch (SignatureException) { threw = true; }
            Assert(threw, "ParseEvent should throw SignatureException");
        }
        return Task.CompletedTask;
    });
}

foreach (var c in Load("callbacks.json"))
{
    await Check($"callback: {c!["name"]}", async () =>
    {
        var handler = new FakeHandler([]);
        var client = new ParspecClient("k", baseUrl: Base, http: new HttpClient(handler));
        var evt = c["event"]!;
        var txid = (string)evt["eventTransactionID"]!;
        var cb = (string?)evt["callback_url"];
        if ((string)c["call"]! == "error") await client.FailAsync(txid, cb, (string)c["message"]!);
        else await client.CallbackAsync(txid, cb, c["fields"]!.AsObject().ToDictionary(kv => kv.Key, kv => (object?)(string?)kv.Value));
        var exp = c["expect"]!;
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
        return new HttpResponseMessage((HttpStatusCode)(int)r["status"]!) { Content = new StringContent(r["body"]!.ToJsonString()) };
    }
}
