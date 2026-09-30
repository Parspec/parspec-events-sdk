// Parspec PM events: subscribe, verify, callback. No dependencies beyond the BCL.
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Parspec.Events;

public class SignatureException(string message) : Exception(message);

public class ParspecApiException(string message, int status, string body) : Exception(message)
{
    public int Status { get; } = status;
    public string Body { get; } = body;
}

public sealed record ParsedEvent(JsonElement Event, string TransactionId, string? CallbackUrl, string? IdempotencyKey);

public sealed record SubscribeResult(string PublicKey, int Replaced);

public static class Signature
{
    // True when X-Signature (base64 RSA-SHA256) verifies against the RAW request bytes.
    // Re-serialized JSON will not verify; pass the body exactly as received.
    public static bool Verify(ReadOnlySpan<byte> rawBody, string? signature, string publicKeyPem)
    {
        if (string.IsNullOrEmpty(signature)) return false;
        try
        {
            using var rsa = RSA.Create();
            rsa.ImportFromPem(publicKeyPem);
            return rsa.VerifyData(rawBody, Convert.FromBase64String(signature), HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        }
        catch (Exception e) when (e is FormatException or ArgumentException or CryptographicException)
        {
            return false;
        }
    }

    // Verify then parse. Throws SignatureException on a bad or missing signature.
    // Deduplicate on TransactionId: PM can deliver the same event more than once.
    // In ASP.NET: Request.Headers["X-Signature"], Request.Headers["Idempotency-Key"].
    public static ParsedEvent ParseEvent(byte[] rawBody, string? signature, string publicKeyPem, string? idempotencyKey = null)
    {
        if (!Verify(rawBody, signature, publicKeyPem)) throw new SignatureException("X-Signature did not verify");
        var root = JsonDocument.Parse(rawBody).RootElement.Clone();
        string? Str(string name) => root.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
        return new ParsedEvent(root, Str("eventTransactionID") ?? "", Str("callback_url"), idempotencyKey);
    }
}

public sealed class ParspecClient
{
    public static readonly IReadOnlyDictionary<string, string> Environments = new Dictionary<string, string>
    {
        ["production"] = "https://platform.parspec.io/platform-api/api/v1/",
        ["sandbox"] = "https://platform-sandbox.parspec.io/platform-api/api/v1/",
        ["preprod"] = "https://uat-platform.parspec.io/platform-api/api/v1/",
    };
    const string DefaultCallback = "integrations/events/callback";

    readonly string _apiKey;
    readonly string _base;
    readonly HttpClient _http;

    public ParspecClient(string apiKey, string environment = "production", string? baseUrl = null, HttpClient? http = null)
    {
        if (string.IsNullOrEmpty(apiKey)) throw new ArgumentException("apiKey is required");
        var b = baseUrl ?? (Environments.TryGetValue(environment, out var e) ? e : throw new ArgumentException($"unknown environment: {environment}"));
        _base = b.EndsWith('/') ? b : b + "/";
        _apiKey = apiKey;
        _http = http ?? new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
    }

    async Task<(int Status, string Text)> CallAsync(HttpMethod method, string pathOrUrl, object body)
    {
        var url = Regex.IsMatch(pathOrUrl, "^https?://") ? pathOrUrl : _base + pathOrUrl.TrimStart('/');
        using var req = new HttpRequestMessage(method, url)
        {
            Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json")
        };
        req.Headers.Add("x-api-key", _apiKey);
        using var res = await _http.SendAsync(req);
        return ((int)res.StatusCode, await res.Content.ReadAsStringAsync());
    }

    // Omit version to clear both 1 and 2 (only one can be active).
    public async Task<IReadOnlyList<(int Version, int Status)>> UnsubscribeAsync(string eventType, int? version = null)
    {
        var results = new List<(int, int)>();
        foreach (var v in version is int only ? [only] : new[] { 1, 2 })
        {
            var (status, _) = await CallAsync(HttpMethod.Delete, "integrations/events/unsubscribe", new { event_type = eventType, event_version = v });
            results.Add((v, status));
        }
        return results;
    }

    // Subscribe is not an upsert, so both versions are cleared first. Returns the NEW public key:
    // every subscribe mints one and events are signed with it from now on — store it and reload it
    // wherever you verify.
    public async Task<SubscribeResult> SubscribeAsync(string eventType, int version, string webhookUrl)
    {
        await UnsubscribeAsync(eventType);
        var body = new { event_type = eventType, event_version = version, webhook_url = webhookUrl };
        var (status, text) = await CallAsync(HttpMethod.Put, "integrations/events/subscribe", body);
        // An org can hold more than one subscription for the same event; each DELETE removes one.
        var replaced = 0;
        while (status == 400 && Regex.IsMatch(text, "already exists", RegexOptions.IgnoreCase) && replaced < 3)
        {
            var named = Regex.Match(text, @"version\s+'?(\d+)'?", RegexOptions.IgnoreCase);
            var v = named.Success ? int.Parse(named.Groups[1].Value) : version;
            var (del, _) = await CallAsync(HttpMethod.Delete, "integrations/events/unsubscribe", new { event_type = eventType, event_version = v });
            if (del != 200) break;
            replaced++;
            (status, text) = await CallAsync(HttpMethod.Put, "integrations/events/subscribe", body);
        }
        string? key = null;
        try { key = JsonNode.Parse(text)?["publicKey"]?.GetValue<string>(); } catch (JsonException) { }
        if (status != 200 || string.IsNullOrEmpty(key))
            throw new ParspecApiException($"subscribe {eventType} v{version} failed: {status} {Trim(text)}", status, text);
        return new SubscribeResult(key, replaced);
    }

    // One callback per event. `fields` carries what PM expects back (orderId, projectErpId, ...).
    public Task CallbackAsync(ParsedEvent evt, IDictionary<string, object?>? fields = null) =>
        CallbackAsync(evt.TransactionId, evt.CallbackUrl, fields);

    public Task CallbackAsync(string transactionId, string? callbackUrl, IDictionary<string, object?>? fields = null) =>
        SendCallbackAsync(transactionId, callbackUrl, "success", fields);

    // The message is shown to the PM user (e.g. a failed credit check).
    public Task FailAsync(ParsedEvent evt, string message, IDictionary<string, object?>? fields = null) =>
        FailAsync(evt.TransactionId, evt.CallbackUrl, message, fields);

    public Task FailAsync(string transactionId, string? callbackUrl, string message, IDictionary<string, object?>? fields = null) =>
        SendCallbackAsync(transactionId, callbackUrl, "error", new Dictionary<string, object?>(fields ?? new Dictionary<string, object?>()) { ["errorMessage"] = message });

    async Task SendCallbackAsync(string transactionId, string? callbackUrl, string status, IDictionary<string, object?>? fields)
    {
        var body = new Dictionary<string, object?> { ["EventTransactionID"] = transactionId, ["EventStatus"] = status };
        foreach (var (k, v) in fields ?? new Dictionary<string, object?>()) body[k] = v;
        var (code, text) = await CallAsync(HttpMethod.Post, string.IsNullOrEmpty(callbackUrl) ? DefaultCallback : callbackUrl, body);
        if (code < 200 || code >= 300) throw new ParspecApiException($"callback failed: {code} {Trim(text)}", code, text);
    }

    static string Trim(string s) => s.Length > 200 ? s[..200] : s;
}
