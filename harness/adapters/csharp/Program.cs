using System.Text.Json;
using Parspec.Events;

var q = JsonDocument.Parse(Console.In.ReadToEnd()).RootElement;
string S(JsonElement e, string k) => e.GetProperty(k).GetString()!;
ParspecClient Client() => new(S(q, "apiKey"), baseUrl: S(q, "base"));
object? output;
try
{
    switch (S(q, "op"))
    {
        case "verify":
            output = q.GetProperty("cases").EnumerateArray().Select(c => Signature.Verify(Convert.FromBase64String(S(c, "body")), S(c, "signature"), S(c, "publicKey"))).ToList();
            break;
        case "callback":
            var ids = new List<string>();
            foreach (var c in q.GetProperty("cases").EnumerateArray())
            {
                var evt = Signature.ParseEvent(Convert.FromBase64String(S(c, "body")), S(c, "signature"), S(q, "publicKey"));
                var fields = c.GetProperty("fields").EnumerateObject().ToDictionary(p => p.Name, p => (object?)p.Value.Clone());
                await Client().CallbackAsync(evt, fields);
                ids.Add(evt.TransactionId);
            }
            output = ids;
            break;
        case "subscribe":
            var r = await Client().SubscribeAsync(S(q, "eventType"), q.GetProperty("version").GetInt32(), S(q, "webhookUrl"));
            output = new { publicKey = r.PublicKey, replaced = r.Replaced };
            break;
        case "unsubscribe":
            int? v = q.TryGetProperty("version", out var ve) && ve.ValueKind == JsonValueKind.Number ? ve.GetInt32() : null;
            output = (await Client().UnsubscribeAsync(S(q, "eventType"), v)).Select(x => x.Status).ToList();
            break;
        default: throw new Exception("unknown op");
    }
    Console.Write(JsonSerializer.Serialize(output));
}
catch (Exception e)
{
    Console.Write(JsonSerializer.Serialize(new { error = e.Message, status = (e as ParspecApiException)?.Status }));
    return 1;
}
return 0;
