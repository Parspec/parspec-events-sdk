// Parspec PM events: subscribe, verify, callback. No dependencies beyond the BCL.
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Parspec.Events;

/// <summary>The signature did not verify: the request did not come from PM, or the key is stale.</summary>
public class SignatureException(string message) : Exception(message);

/// <summary>The signature verified, but the body is not a PM event envelope.</summary>
public class EventException(string message, Exception? inner = null) : FormatException(message, inner);

/// <summary>A PM API call failed. Status is the HTTP status, or 0 when there was no response
/// (network failure, timeout) or the request was refused before sending.</summary>
public class ParspecApiException(string message, int status, string body, Exception? inner = null) : Exception(message, inner)
{
    public int Status { get; } = status;
    public string Body { get; } = body;
}

public sealed record ParsedEvent(JsonElement Event, string TransactionId, string? CallbackUrl, string? IdempotencyKey);

public sealed record SubscribeResult(string PublicKey, int Replaced);

public static class Signature
{
    /// <summary>True when X-Signature (base64 RSA-SHA256) verifies against the RAW request bytes, false
    /// otherwise. Never throws: a bad signature, a bad key and a non-RSA key all return false.
    /// Re-serialized JSON will not verify; pass the body exactly as received.</summary>
    public static bool Verify(ReadOnlySpan<byte> rawBody, string? signature, string? publicKeyPem)
    {
        if (string.IsNullOrEmpty(signature) || string.IsNullOrEmpty(publicKeyPem)) return false;
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

    /// <summary>Verify then parse. Throws SignatureException on a bad or missing signature, EventException
    /// when a signed body is not a PM event. Deduplicate on TransactionId: PM can deliver an event twice.
    /// In ASP.NET: Request.Headers["X-Signature"], Request.Headers["Idempotency-Key"].</summary>
    public static ParsedEvent ParseEvent(byte[] rawBody, string? signature, string? publicKeyPem, string? idempotencyKey = null)
    {
        if (!Verify(rawBody, signature, publicKeyPem)) throw new SignatureException("X-Signature did not verify");
        JsonElement root;
        try
        {
            using var doc = JsonDocument.Parse(rawBody);
            root = doc.RootElement.Clone();
        }
        catch (JsonException e) { throw new EventException($"body is not JSON: {e.Message}", e); }
        string? Str(string name) => root.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
        var txid = root.ValueKind == JsonValueKind.Object ? Str("eventTransactionID") : null;
        if (string.IsNullOrEmpty(txid)) throw new EventException("body is not a PM event: expected an object with an eventTransactionID");
        return new ParsedEvent(root, txid, Str("callback_url"), idempotencyKey);
    }
}

public sealed class ParspecClient
{
    public static readonly IReadOnlyDictionary<string, string> Environments = new Dictionary<string, string>
    {
        ["production"] = "https://platform.parspec.io/platform-api/api/v1/",
        ["sandbox"] = "https://platform-sandbox.parspec.io/platform-api/api/v1/",
        ["preprod"] = "https://uat-platform.parspec.io/platform-api/api/v1/",
    }.AsReadOnly();
    const string DefaultCallback = "integrations/events/callback";

    // One pooled client for every ParspecClient that isn't given its own: no socket exhaustion from
    // many instances, and connections are recycled so DNS changes are picked up.
    static readonly HttpClient SharedHttp = new(new SocketsHttpHandler { PooledConnectionLifetime = TimeSpan.FromMinutes(5) })
    {
        Timeout = Timeout.InfiniteTimeSpan   // per-request timeout below instead
    };

    readonly string _apiKey;
    readonly Uri _base;
    readonly HttpClient _http;
    readonly TimeSpan _timeout;

    public ParspecClient(string apiKey, string environment = "production", string? baseUrl = null, HttpClient? http = null, TimeSpan? timeout = null)
    {
        if (string.IsNullOrEmpty(apiKey)) throw new ArgumentException("apiKey is required", nameof(apiKey));
        var b = baseUrl ?? (Environments.TryGetValue(environment, out var e) ? e : throw new ArgumentException($"unknown environment: {environment}", nameof(environment)));
        _base = new Uri(b.EndsWith('/') ? b : b + "/");
        _apiKey = apiKey;
        _http = http ?? SharedHttp;
        _timeout = timeout ?? TimeSpan.FromSeconds(30);
    }

    // Relative paths resolve against the base. An absolute URL is allowed only on the base's origin:
    // the API key goes with every request, so a host named in a payload must never receive it.
    Uri Resolve(string pathOrUrl)
    {
        if (!Regex.IsMatch(pathOrUrl, "^https?://", RegexOptions.IgnoreCase)) return new Uri(_base, pathOrUrl.TrimStart('/'));
        if (!Uri.TryCreate(pathOrUrl, UriKind.Absolute, out var url)) throw new ParspecApiException($"invalid URL {pathOrUrl}", 0, "");
        if (Uri.Compare(url, _base, UriComponents.SchemeAndServer, UriFormat.SafeUnescaped, StringComparison.OrdinalIgnoreCase) != 0)
            throw new ParspecApiException($"refusing to send the API key to {url.GetLeftPart(UriPartial.Authority)}", 0, "");
        return url;
    }

    async Task<(int Status, string Text)> CallAsync(HttpMethod method, string pathOrUrl, object body, CancellationToken ct)
    {
        var url = Resolve(pathOrUrl);
        using var req = new HttpRequestMessage(method, url)
        {
            Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json")
        };
        req.Headers.Add("x-api-key", _apiKey);
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(_timeout);
        try
        {
            using var res = await _http.SendAsync(req, cts.Token).ConfigureAwait(false);
            return ((int)res.StatusCode, await res.Content.ReadAsStringAsync(cts.Token).ConfigureAwait(false));
        }
        catch (HttpRequestException e) { throw new ParspecApiException($"{method} {url} failed: {e.Message}", 0, "", e); }
        catch (OperationCanceledException e) when (!ct.IsCancellationRequested)
        {
            throw new ParspecApiException($"{method} {url} timed out after {_timeout.TotalSeconds}s", 0, "", e);
        }
    }

    /// <summary>Omit version to clear both 1 and 2 (only one can be active).</summary>
    public async Task<IReadOnlyList<(int Version, int Status)>> UnsubscribeAsync(string eventType, int? version = null, CancellationToken ct = default)
    {
        var results = new List<(int, int)>();
        foreach (var v in version is int only ? [only] : new[] { 1, 2 })
        {
            var (status, _) = await CallAsync(HttpMethod.Delete, "integrations/events/unsubscribe", new { event_type = eventType, event_version = v }, ct).ConfigureAwait(false);
            results.Add((v, status));
        }
        return results;
    }

    /// <summary>Subscribe is not an upsert, so both versions are cleared first. Returns the NEW public key:
    /// every subscribe mints one and events are signed with it from now on. Store it and reload it
    /// wherever you verify.</summary>
    public async Task<SubscribeResult> SubscribeAsync(string eventType, int version, string webhookUrl, CancellationToken ct = default)
    {
        await UnsubscribeAsync(eventType, null, ct).ConfigureAwait(false);
        var body = new { event_type = eventType, event_version = version, webhook_url = webhookUrl };
        var (status, text) = await CallAsync(HttpMethod.Put, "integrations/events/subscribe", body, ct).ConfigureAwait(false);
        // An org can hold more than one subscription for the same event; each DELETE removes one.
        var replaced = 0;
        while (status == 400 && Regex.IsMatch(text, "already exists", RegexOptions.IgnoreCase) && replaced < 3)
        {
            var named = Regex.Match(text, @"version\s+'?(\d+)'?", RegexOptions.IgnoreCase);
            var v = named.Success && int.TryParse(named.Groups[1].Value, NumberStyles.None, CultureInfo.InvariantCulture, out var n) ? n : version;
            var (del, _) = await CallAsync(HttpMethod.Delete, "integrations/events/unsubscribe", new { event_type = eventType, event_version = v }, ct).ConfigureAwait(false);
            if (del != 200) break;
            replaced++;
            (status, text) = await CallAsync(HttpMethod.Put, "integrations/events/subscribe", body, ct).ConfigureAwait(false);
        }
        string? key = null;
        try
        {
            if (JsonNode.Parse(text) is JsonObject o && o["publicKey"] is JsonValue k && k.TryGetValue<string>(out var s)) key = s;
        }
        catch (JsonException) { /* non-JSON body: reported below */ }
        if (status != 200 || string.IsNullOrEmpty(key))
            throw new ParspecApiException($"subscribe {eventType} v{version} failed: {status} {Trim(text)}", status, text);
        return new SubscribeResult(key, replaced);
    }

    /// <summary>One callback per event. fields carries what PM expects back (orderId, projectErpId, ...).</summary>
    public Task CallbackAsync(ParsedEvent evt, IDictionary<string, object?>? fields = null, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(evt);
        return CallbackAsync(evt.TransactionId, evt.CallbackUrl, fields, ct);
    }

    public Task CallbackAsync(string transactionId, string? callbackUrl, IDictionary<string, object?>? fields = null, CancellationToken ct = default) =>
        SendCallbackAsync(transactionId, callbackUrl, "success", fields, ct);

    /// <summary>An error callback. The message is shown to the PM user (e.g. a failed credit check).</summary>
    public Task FailAsync(ParsedEvent evt, string message, IDictionary<string, object?>? fields = null, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(evt);
        return FailAsync(evt.TransactionId, evt.CallbackUrl, message, fields, ct);
    }

    public Task FailAsync(string transactionId, string? callbackUrl, string message, IDictionary<string, object?>? fields = null, CancellationToken ct = default) =>
        SendCallbackAsync(transactionId, callbackUrl, "error", new Dictionary<string, object?>(fields ?? new Dictionary<string, object?>()) { ["errorMessage"] = message }, ct);

    async Task SendCallbackAsync(string transactionId, string? callbackUrl, string status, IDictionary<string, object?>? fields, CancellationToken ct)
    {
        // The SDK's two fields last, so a caller's fields cannot forge them.
        var body = new Dictionary<string, object?>(fields ?? new Dictionary<string, object?>())
        {
            ["EventTransactionID"] = transactionId,
            ["EventStatus"] = status
        };
        var (code, text) = await CallAsync(HttpMethod.Post, string.IsNullOrEmpty(callbackUrl) ? DefaultCallback : callbackUrl, body, ct).ConfigureAwait(false);
        if (code < 200 || code >= 300) throw new ParspecApiException($"callback failed: {code} {Trim(text)}", code, text);
    }

    static string Trim(string s) => s.Length > 200 ? s[..200] : s;
}
