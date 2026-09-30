package com.parspec.events;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

// Runs the shared fixtures in ../fixtures. See README "Tests" for the command.
@SuppressWarnings("unchecked")
public final class FixturesTest {
    static final Path FX = Path.of(System.getProperty("fixtures", "../fixtures"));
    static final String BASE = "https://pm.example/platform-api/api/v1/";
    static int pass, fail;

    interface Body { void run() throws Exception; }

    static void check(String name, Body body) {
        try { body.run(); pass++; System.out.println("ok   " + name); }
        catch (Throwable e) { fail++; System.out.println("FAIL " + name + ": " + e.getMessage()); }
    }

    static void require(boolean cond, String what) { if (!cond) throw new AssertionError(what); }

    static List<Map<String, Object>> load(String name) throws Exception {
        return (List<Map<String, Object>>) Json.parse(Files.readString(FX.resolve(name)));
    }

    record Call(String method, String url, Object body, String apiKey) {}

    // Records requests and replays canned responses (200 {} when the script runs out).
    static ParspecClient.Transport fake(List<Call> calls, List<Map<String, Object>> responses) {
        return (method, url, headers, body) -> {
            calls.add(new Call(method, url, Json.parse(body), headers.get("x-api-key")));
            Map<String, Object> r = calls.size() <= responses.size() ? responses.get(calls.size() - 1) : Map.of("status", 200L, "body", Map.of());
            return new ParspecClient.Response(((Long) r.get("status")).intValue(), Json.write(r.get("body")));
        };
    }

    public static void main(String[] args) throws Exception {
        for (Map<String, Object> c : load("signatures.json")) {
            check("signature: " + c.get("name"), () -> {
                String key = Files.readString(FX.resolve("keys").resolve((String) c.get("key")));
                byte[] raw = ((String) c.get("body")).getBytes(StandardCharsets.UTF_8);
                String sig = (String) c.get("signature");
                boolean valid = (Boolean) c.get("valid");
                require(Signature.verify(raw, sig, key) == valid, "verify should be " + valid);
                if (valid) {
                    Signature.ParsedEvent p = Signature.parseEvent(raw, sig, key, "idem-1");
                    require(p.transactionId().equals(p.event().get("eventTransactionID")), "transaction id");
                    require("idem-1".equals(p.idempotencyKey()), "idempotency key");
                } else {
                    boolean threw = false;
                    try { Signature.parseEvent(raw, sig, key); } catch (Signature.SignatureException e) { threw = true; }
                    require(threw, "parseEvent should throw SignatureException");
                }
            });
        }

        for (Map<String, Object> c : load("callbacks.json")) {
            check("callback: " + c.get("name"), () -> {
                List<Call> calls = new ArrayList<>();
                ParspecClient client = new ParspecClient("k", BASE, fake(calls, List.of()));
                Map<String, Object> evt = (Map<String, Object>) c.get("event");
                String txid = (String) evt.get("eventTransactionID");
                String cb = (String) evt.get("callback_url");
                if ("error".equals(c.get("call"))) client.fail(txid, cb, (String) c.get("message"));
                else client.callback(txid, cb, (Map<String, Object>) c.get("fields"));
                Map<String, Object> exp = (Map<String, Object>) c.get("expect");
                require(calls.size() == 1, "one request");
                Call got = calls.get(0);
                require(got.method().equals(exp.get("method")), "method " + got.method());
                require(got.url().equals(exp.get("url")), "url " + got.url());
                require(got.body().equals(exp.get("body")), "body " + got.body());
                require("k".equals(got.apiKey()), "x-api-key");
            });
        }

        for (Map<String, Object> c : load("subscribe.json")) {
            check("subscribe: " + c.get("name"), () -> {
                List<Map<String, Object>> exchange = (List<Map<String, Object>>) c.get("exchange");
                List<Map<String, Object>> responses = new ArrayList<>();
                for (Map<String, Object> x : exchange) responses.add((Map<String, Object>) x.get("response"));
                List<Call> calls = new ArrayList<>();
                ParspecClient client = new ParspecClient("k", BASE, fake(calls, responses));
                Map<String, Object> a = (Map<String, Object>) c.get("args");
                Map<String, Object> exp = (Map<String, Object>) c.get("expect");
                String type = (String) a.get("eventType");
                int version = ((Long) a.get("version")).intValue();
                String url = (String) a.get("webhookUrl");
                if (exp.containsKey("error")) {
                    int status = 0;
                    try { client.subscribe(type, version, url); } catch (ParspecClient.ParspecApiException e) { status = e.status(); }
                    require(status == ((Long) exp.get("error")).intValue(), "should throw with status " + exp.get("error") + ", got " + status);
                } else {
                    ParspecClient.SubscribeResult r = client.subscribe(type, version, url);
                    require(r.publicKey().equals(exp.get("publicKey")) && r.replaced() == ((Long) exp.get("replaced")).intValue(), "result " + r);
                }
                require(calls.size() == exchange.size(), "request count " + calls.size());
                for (int k = 0; k < exchange.size(); k++) {
                    Map<String, Object> want = (Map<String, Object>) exchange.get(k).get("request");
                    Call got = calls.get(k);
                    require(got.method().equals(want.get("method")) && got.url().equals(BASE + want.get("path")) && got.body().equals(want.get("body")),
                        "request " + k + ": " + got);
                }
            });
        }

        System.out.println(pass + " passed, " + fail + " failed");
        System.exit(fail == 0 ? 0 : 1);
    }
}
