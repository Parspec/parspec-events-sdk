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
            if (Boolean.TRUE.equals(r.get("network"))) throw new java.net.ConnectException("connection refused");
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
                if (valid && !c.containsKey("envelope")) {
                    Signature.ParsedEvent p = Signature.parseEvent(raw, sig, key, "idem-1");
                    require(p.transactionId().equals(p.event().get("eventTransactionID")), "transaction id");
                    require("idem-1".equals(p.idempotencyKey()), "idempotency key");
                } else {
                    Throwable thrown = null;
                    try { Signature.parseEvent(raw, sig, key); } catch (Throwable e) { thrown = e; }
                    require(valid ? thrown instanceof Signature.EventException : thrown instanceof Signature.SignatureException,
                        "parseEvent should throw " + (valid ? "EventException" : "SignatureException") + ", threw " + thrown);
                }
            });
        }

        for (Map<String, Object> c : load("callbacks.json")) {
            check("callback: " + c.get("name"), () -> {
                List<Call> calls = new ArrayList<>();
                List<Map<String, Object>> responses = c.containsKey("response") ? List.of((Map<String, Object>) c.get("response")) : List.of();
                ParspecClient client = new ParspecClient("k", BASE, fake(calls, responses));
                Map<String, Object> evt = (Map<String, Object>) c.get("event");
                String txid = (String) evt.get("eventTransactionID");
                String cb = (String) evt.get("callback_url");
                Map<String, Object> exp = (Map<String, Object>) c.get("expect");
                int status = -1;   // -1: nothing thrown
                try {
                    if ("error".equals(c.get("call"))) client.fail(txid, cb, (String) c.get("message"));
                    else client.callback(txid, cb, (Map<String, Object>) c.get("fields"));
                } catch (ParspecClient.ParspecApiException e) { status = e.status(); }
                int wantStatus = exp.containsKey("error") ? ((Long) exp.get("error")).intValue() : -1;
                require(status == wantStatus, "expected error status " + wantStatus + ", got " + status);
                if (!exp.containsKey("method")) { require(calls.isEmpty(), "no request may be sent"); return; }
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

        // The JSON codec against literal expectations: the fixtures above parse and compare with the same
        // codec, so a parser bug and a writer bug could cancel out there.
        check("json: escapes and unicode", () -> {
            require("\"\\\"\\\\\\n\\r\\t\\u0001é\"".equals(Json.write("\"\\\n\r\t\u0001é")), "writer escapes: " + Json.write("\"\\\n\r\t\u0001é"));
            require("\"\\\n\r\t\b\f/é😀".equals(Json.parse("\"\\\"\\\\\\n\\r\\t\\b\\f\\/\\u00e9\\ud83d\\ude00\"")), "parser escapes");
        });
        check("json: numbers keep their precision", () -> {
            require(Long.valueOf(42).equals(Json.parse("42")), "long");
            require(new java.math.BigInteger("12345678901234567890").equals(Json.parse("12345678901234567890")), "beyond Long");
            require("12.3400".equals(Json.write(Json.parse("12.3400"))), "decimal digits kept: " + Json.write(Json.parse("12.3400")));
        });
        check("json: invalid input is rejected with an IllegalArgumentException", () -> {
            for (String bad : new String[] { "", "01", "+1", ".5", "1.", "[1,]", "{\"a\":1,}", "\"\\u-123\"", "\"\\u12G4\"", "\"a\u0001b\"",
                    "\u000b1", "nul", "[1] x", "\"unterminated" }) {
                boolean rejected = false;
                try { Json.parse(bad); } catch (IllegalArgumentException e) { rejected = true; }
                require(rejected, "should reject: " + bad);
            }
        });
        check("json: deep nesting is an error, not a StackOverflowError", () -> {
            String deep = "[".repeat(100_000) + "]".repeat(100_000);
            boolean rejected = false;
            try { Json.parse(deep); } catch (IllegalArgumentException e) { rejected = e.getMessage().contains("nested deeper"); }
            require(rejected, "deep nesting");
            require(Json.parse("[".repeat(Json.MAX_DEPTH) + "]".repeat(Json.MAX_DEPTH)) instanceof List, "MAX_DEPTH itself is fine");
        });
        check("json: the writer refuses NaN and infinities", () -> {
            for (Object bad : new Object[] { Double.NaN, Double.POSITIVE_INFINITY, Float.NEGATIVE_INFINITY }) {
                boolean rejected = false;
                try { Json.write(bad); } catch (IllegalArgumentException e) { rejected = true; }
                require(rejected, "should refuse " + bad);
            }
        });
        check("subscribe: the 'already exists' retry works under a Turkish locale", () -> {
            java.util.Locale prev = java.util.Locale.getDefault();
            java.util.Locale.setDefault(java.util.Locale.forLanguageTag("tr-TR"));
            try {
                List<Call> calls = new ArrayList<>();
                List<Map<String, Object>> responses = List.of(
                    Map.of("status", 200L, "body", Map.of()), Map.of("status", 200L, "body", Map.of()),
                    Map.of("status", 400L, "body", Map.of("error", "AN ACTIVE SUBSCRIPTION ALREADY EXISTS FOR EVENT TYPE X AND VERSION 1")),
                    Map.of("status", 200L, "body", Map.of()), Map.of("status", 200L, "body", Map.of("publicKey", "K")));
                ParspecClient.SubscribeResult r = new ParspecClient("k", BASE, fake(calls, responses)).subscribe("x", 1, "https://erp.example/w");
                require(r.replaced() == 1 && "K".equals(r.publicKey()), "result " + r);
            } finally { java.util.Locale.setDefault(prev); }
        });

        for (Map<String, Object> c : load("receiver.json")) {
            check("receiver: " + c.get("name"), () -> {
                List<Map<String, Object>> responses = new ArrayList<>();
                for (Object st : (List<Object>) c.getOrDefault("callbackResponses", List.of())) responses.add(Map.of("status", st, "body", Map.of()));
                List<Call> sent = new ArrayList<>();
                ParspecClient client = new ParspecClient("k", BASE, fake(sent, responses));
                TestStores stores = new TestStores(c);
                Receiver receiver = new Receiver(client, stores, stores, null);
                List<String> calls = new ArrayList<>();
                for (Map.Entry<String, Object> h : ((Map<String, Object>) c.get("handlers")).entrySet()) {
                    List<Map<String, Object>> behaviours = (List<Map<String, Object>>) h.getValue();
                    int[] n = { 0 };
                    receiver.on(h.getKey(), (evt, ctx) -> {
                        calls.add(ctx.eventType() + "|" + ctx.transactionId());
                        Map<String, Object> b = behaviours.get(Math.min(n[0]++, behaviours.size() - 1));
                        if (b.containsKey("throw")) throw new IllegalStateException((String) b.get("throw"));
                        return (Map<String, Object>) b.get("return");
                    });
                }
                List<Object> got = new ArrayList<>(), want = new ArrayList<>();
                for (Map<String, Object> d : (List<Map<String, Object>>) c.get("deliveries")) {
                    got.add((long) receiver.handle(((String) d.get("body")).getBytes(StandardCharsets.UTF_8), (String) d.get("signature"), null));
                    want.add(d.get("status"));
                }
                Map<String, Object> exp = (Map<String, Object>) c.get("expect");
                require(got.equals(want), "statuses " + got);
                List<String> wantCalls = new ArrayList<>();
                for (Map<String, Object> x : (List<Map<String, Object>>) exp.get("calls")) wantCalls.add(x.get("eventType") + "|" + x.get("transactionId"));
                require(calls.equals(wantCalls), "calls " + calls);
                List<Object> bodies = new ArrayList<>();
                for (Call x : sent) bodies.add(x.body());
                require(bodies.equals(exp.get("callbacks")), "callbacks " + bodies);
                require(new java.util.TreeSet<>(stores.done).equals(new java.util.TreeSet<>((List<String>) exp.get("done"))), "done " + stores.done);
                require(new java.util.TreeSet<>(stores.processing).equals(new java.util.TreeSet<>((List<String>) exp.get("processing"))), "processing " + stores.processing);
            });
        }
        check("receiver: subscribe saves keys to a writable store and returns them", () -> {
            List<Call> sent = new ArrayList<>();
            List<Map<String, Object>> responses = List.of(Map.of("status", 200L, "body", Map.of()), Map.of("status", 200L, "body", Map.of()),
                Map.of("status", 200L, "body", Map.of("publicKey", "KEY-A")));
            Receiver.MemoryKeyStore keys = new Receiver.MemoryKeyStore();
            Receiver receiver = new Receiver(new ParspecClient("k", BASE, fake(sent, responses)), keys, null, null)
                .on("inventory.fetchPrice", (e, ctx) -> null, 2);
            require(Map.of("inventory.fetchPrice", "KEY-A").equals(receiver.subscribe("https://erp.example/hook")), "returned");
            require("KEY-A".equals(keys.get().get("inventory.fetchPrice")), "saved");
            require(Long.valueOf(2).equals(((Map<String, Object>) sent.get(2).body()).get("event_version")), "version");
        });
        check("receiver: MemoryTransactionStore claims once and expires stale claims", () -> {
            Receiver.MemoryTransactionStore t = new Receiver.MemoryTransactionStore(java.time.Duration.ofMillis(20));
            require(t.claim("a") && !t.claim("a"), "claim once");
            Thread.sleep(40);
            require(t.claim("a"), "stale claim taken over");
            t.done("a");
            require(!t.claim("a"), "done");
        });

        System.out.println(pass + " passed, " + fail + " failed");
        System.exit(fail == 0 ? 0 : 1);
    }

    // A store the test writes itself, as a developer would: read-only keys (like env vars) and a transaction set.
    static final class TestStores implements Receiver.KeyStore, Receiver.TransactionStore {
        final Map<String, String> keys = new java.util.HashMap<>();
        final java.util.Set<String> processing = new java.util.HashSet<>(), done = new java.util.HashSet<>();

        TestStores(Map<String, Object> c) throws java.io.IOException {
            for (Map.Entry<String, Object> e : ((Map<String, Object>) c.get("keys")).entrySet())
                keys.put(e.getKey(), Files.readString(FX.resolve("keys").resolve((String) e.getValue())));
            processing.addAll((List<String>) c.getOrDefault("processing", List.of()));
            done.addAll((List<String>) c.getOrDefault("done", List.of()));
        }

        @Override public Map<String, String> get() { return keys; }
        @Override public boolean claim(String t) { return !processing.contains(t) && !done.contains(t) && processing.add(t); }
        @Override public void done(String t) { processing.remove(t); done.add(t); }
        @Override public void release(String t) { processing.remove(t); }
    }
}
