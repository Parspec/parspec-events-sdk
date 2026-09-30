package com.parspec.events;

import java.io.IOException;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class ParspecClient {
    public static final Map<String, String> ENVIRONMENTS = Map.of(
        "production", "https://platform.parspec.io/platform-api/api/v1/",
        "sandbox", "https://platform-sandbox.parspec.io/platform-api/api/v1/",
        "preprod", "https://uat-platform.parspec.io/platform-api/api/v1/",
        "uat", "https://uat-platform.parspec.io/platform-api/api/v1/",
        "local", "http://127.0.0.1:4800/platform-api/api/v1/");   // the playground: node harness/playground.js
    private static final String DEFAULT_CALLBACK = "integrations/events/callback";
    private static final Pattern ABSOLUTE = Pattern.compile("https?://", Pattern.CASE_INSENSITIVE);
    private static final Pattern NAMED_VERSION = Pattern.compile("version\\s+'?(\\d+)'?", Pattern.CASE_INSENSITIVE);

    // status is the HTTP status, or 0 when there was no response (network failure, timeout) or the
    // request was refused before sending.
    public static class ParspecApiException extends RuntimeException {
        private static final long serialVersionUID = 1L;
        private final int status;
        private final String body;
        public ParspecApiException(String message, int status, String body) { this(message, status, body, null); }
        public ParspecApiException(String message, int status, String body, Throwable cause) { super(message, cause); this.status = status; this.body = body; }
        public int status() { return status; }
        public String body() { return body; }
    }

    public record Response(int status, String body) {}
    public record SubscribeResult(String publicKey, int replaced) {}

    // The HTTP seam: swap it to use your own client or to test without a network.
    @FunctionalInterface
    public interface Transport {
        Response send(String method, String url, Map<String, String> headers, String body) throws IOException, InterruptedException;
    }

    private final String apiKey;
    private final String base;
    private final Transport transport;

    public ParspecClient(String apiKey, String environment) { this(apiKey, ENVIRONMENTS.get(environment), defaultTransport()); }

    // transport may be null for the built-in java.net.http client (e.g. a custom baseUrl only).
    public ParspecClient(String apiKey, String baseUrl, Transport transport) {
        if (apiKey == null || apiKey.isEmpty()) throw new IllegalArgumentException("apiKey is required");
        if (baseUrl == null) throw new IllegalArgumentException("unknown environment");
        this.apiKey = apiKey;
        this.base = baseUrl.endsWith("/") ? baseUrl : baseUrl + "/";
        this.transport = transport == null ? defaultTransport() : transport;
    }

    // One HttpClient for every ParspecClient on the default transport: it is thread-safe and pools connections.
    private static final HttpClient SHARED_HTTP = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(30)).build();

    private static Transport defaultTransport() {
        HttpClient http = SHARED_HTTP;
        return (method, url, headers, body) -> {
            HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(url)).timeout(Duration.ofSeconds(30))
                .method(method, HttpRequest.BodyPublishers.ofString(body));
            headers.forEach(b::header);
            HttpResponse<String> r = http.send(b.build(), HttpResponse.BodyHandlers.ofString());
            return new Response(r.statusCode(), r.body());
        };
    }

    // Relative paths resolve against the base. An absolute URL is allowed only on the base's origin:
    // the API key goes with every request, so a host named in a payload must never receive it.
    private String resolve(String pathOrUrl) {
        if (!ABSOLUTE.matcher(pathOrUrl).lookingAt()) return base + pathOrUrl.replaceFirst("^/+", "");
        URI url, b = URI.create(base);
        try { url = new URI(pathOrUrl); } catch (URISyntaxException e) { throw new ParspecApiException("invalid URL " + pathOrUrl, 0, ""); }
        boolean sameOrigin = url.getScheme().equalsIgnoreCase(b.getScheme()) && url.getHost() != null
            && url.getHost().equalsIgnoreCase(b.getHost()) && port(url) == port(b);
        if (!sameOrigin) throw new ParspecApiException("refusing to send the API key to " + url.getScheme() + "://" + url.getRawAuthority(), 0, "");
        return pathOrUrl;
    }

    private static int port(URI u) { return u.getPort() != -1 ? u.getPort() : "https".equalsIgnoreCase(u.getScheme()) ? 443 : 80; }

    private Response call(String method, String pathOrUrl, Map<String, Object> body) {
        String url = resolve(pathOrUrl);
        try {
            Response r = transport.send(method, url, Map.of("x-api-key", apiKey, "Content-Type", "application/json"), Json.write(body));
            return new Response(r.status(), r.body() == null ? "" : r.body());
        } catch (IOException | IllegalArgumentException e) {
            throw new ParspecApiException(method + " " + url + " failed: " + e.getMessage(), 0, "", e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new ParspecApiException(method + " " + url + " interrupted", 0, "", e);
        }
    }

    private static Map<String, Object> obj(Object... kv) {
        Map<String, Object> m = new LinkedHashMap<>();
        for (int k = 0; k < kv.length; k += 2) m.put((String) kv[k], kv[k + 1]);
        return m;
    }

    // Pass null to clear both 1 and 2 (only one can be active).
    public List<Response> unsubscribe(String eventType, Integer version) {
        List<Response> out = new ArrayList<>();
        for (int v : version == null ? new int[] {1, 2} : new int[] {version})
            out.add(call("DELETE", "integrations/events/unsubscribe", obj("event_type", eventType, "event_version", v)));
        return out;
    }

    // Subscribe is not an upsert, so both versions are cleared first. Returns the NEW public key:
    // every subscribe mints one and events are signed with it from now on — store it and reload it
    // wherever you verify.
    public SubscribeResult subscribe(String eventType, int version, String webhookUrl) {
        unsubscribe(eventType, null);
        Map<String, Object> body = obj("event_type", eventType, "event_version", version, "webhook_url", webhookUrl);
        Response res = call("PUT", "integrations/events/subscribe", body);
        // An org can hold more than one subscription for the same event; each DELETE removes one.
        int replaced = 0;
        while (res.status() == 400 && res.body().toLowerCase(Locale.ROOT).contains("already exists") && replaced < 3) {
            Matcher m = NAMED_VERSION.matcher(res.body());
            int v = version;
            if (m.find()) try { v = Integer.parseInt(m.group(1)); } catch (NumberFormatException ignored) { /* keep the requested version */ }
            if (call("DELETE", "integrations/events/unsubscribe", obj("event_type", eventType, "event_version", v)).status() != 200) break;
            replaced++;
            res = call("PUT", "integrations/events/subscribe", body);
        }
        String key = null;
        try {
            Object parsed = Json.parse(res.body());
            if (parsed instanceof Map && ((Map<?, ?>) parsed).get("publicKey") instanceof String) key = (String) ((Map<?, ?>) parsed).get("publicKey");
        } catch (IllegalArgumentException ignored) { /* non-JSON body */ }
        if (res.status() != 200 || key == null || key.isEmpty())
            throw new ParspecApiException("subscribe " + eventType + " v" + version + " failed: " + res.status() + " " + trim(res.body()), res.status(), res.body());
        return new SubscribeResult(key, replaced);
    }

    // One callback per event. fields carries what PM expects back (orderId, projectErpId, ...).
    public void callback(Signature.ParsedEvent evt, Map<String, Object> fields) { callback(evt.transactionId(), evt.callbackUrl(), fields); }

    public void callback(String transactionId, String callbackUrl, Map<String, Object> fields) {
        sendCallback(transactionId, callbackUrl, "success", fields);
    }

    // The message is shown to the PM user (e.g. a failed credit check).
    public void fail(Signature.ParsedEvent evt, String message) { fail(evt.transactionId(), evt.callbackUrl(), message); }

    public void fail(String transactionId, String callbackUrl, String message) {
        Map<String, Object> fields = new LinkedHashMap<>();
        fields.put("errorMessage", message);
        sendCallback(transactionId, callbackUrl, "error", fields);
    }

    private void sendCallback(String transactionId, String callbackUrl, String status, Map<String, Object> fields) {
        // The SDK's two fields last, so a caller's fields cannot forge them.
        Map<String, Object> body = fields == null ? new LinkedHashMap<>() : new LinkedHashMap<>(fields);
        body.put("EventTransactionID", transactionId);
        body.put("EventStatus", status);
        Response r = call("POST", callbackUrl == null || callbackUrl.isEmpty() ? DEFAULT_CALLBACK : callbackUrl, body);
        if (r.status() < 200 || r.status() >= 300)
            throw new ParspecApiException("callback failed: " + r.status() + " " + trim(r.body()), r.status(), r.body());
    }

    private static String trim(String s) { return s.length() > 200 ? s.substring(0, 200) : s; }
}
