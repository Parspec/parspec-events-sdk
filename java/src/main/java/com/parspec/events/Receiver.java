package com.parspec.events;

import com.sun.net.httpserver.HttpHandler;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executor;
import java.util.concurrent.RejectedExecutionException;
import java.util.function.BiConsumer;

// Register a function per event type; the SDK verifies, routes, dedupes and calls back.
//
// Storage is yours. Implement KeyStore (read-only: env vars, a keychain, a secrets manager) or
// WritableKeyStore (so subscribe() can save new keys), and TransactionStore: a database row or Redis
// SET NX in production, so claims survive restarts and span servers. MemoryKeyStore and
// MemoryTransactionStore are the in-process versions, for development.
public final class Receiver {

    public interface KeyStore {
        // Every event type's current public key (PEM).
        Map<String, String> get();
    }

    public interface WritableKeyStore extends KeyStore {
        void set(String eventType, String publicKeyPem);
    }

    public interface TransactionStore {
        // Atomically claim a transaction: false when it is done or another worker holds it.
        boolean claim(String transactionId);
        void done(String transactionId);
        // Give the claim back so a redelivery can retry.
        void release(String transactionId);
    }

    public static final class MemoryKeyStore implements WritableKeyStore {
        private final Map<String, String> keys = new ConcurrentHashMap<>();
        public MemoryKeyStore() {}
        public MemoryKeyStore(Map<String, String> initial) { keys.putAll(initial); }
        @Override public Map<String, String> get() { return Map.copyOf(keys); }
        @Override public void set(String eventType, String publicKeyPem) { keys.put(eventType, publicKeyPem); }
    }

    // lease: a claim older than this counts as abandoned (the worker died), so a redelivery can take it.
    public static final class MemoryTransactionStore implements TransactionStore {
        private final long leaseNanos;
        private final Map<String, Long> processing = new ConcurrentHashMap<>();
        private final Map<String, Boolean> done = new ConcurrentHashMap<>();
        public MemoryTransactionStore() { this(Duration.ofMinutes(15)); }
        public MemoryTransactionStore(Duration lease) { leaseNanos = lease.toNanos(); }

        @Override public synchronized boolean claim(String transactionId) {
            if (done.containsKey(transactionId)) return false;
            Long at = processing.get(transactionId);
            if (at != null && System.nanoTime() - at < leaseNanos) return false;
            processing.put(transactionId, System.nanoTime());
            return true;
        }
        @Override public synchronized void done(String transactionId) { processing.remove(transactionId); done.put(transactionId, true); }
        @Override public synchronized void release(String transactionId) { processing.remove(transactionId); }
    }

    public record EventContext(String eventType, String transactionId, String idempotencyKey) {}

    // Return the callback fields (or null, for a plain acknowledgement). Throwing sends an error
    // callback with the message, which PM shows to the user.
    @FunctionalInterface
    public interface Handler {
        Map<String, Object> handle(Signature.ParsedEvent event, EventContext ctx) throws Exception;
    }

    // The result of accept(): answer PM with status() now, then call process().
    public record Accepted(int status, Runnable process, String eventType, String transactionId, boolean duplicate) {
        static Accepted refused(int status) { return new Accepted(status, () -> {}, null, null, false); }
    }

    private record Registration(Handler handler, int version) {}

    private final ParspecClient client;
    private final KeyStore keys;
    private final TransactionStore transactions;
    private final BiConsumer<Exception, EventContext> onError;
    private final Map<String, Registration> handlers = new ConcurrentHashMap<>();

    public Receiver(ParspecClient client) { this(client, new MemoryKeyStore(), new MemoryTransactionStore(), null); }

    public Receiver(ParspecClient client, KeyStore keys, TransactionStore transactions, BiConsumer<Exception, EventContext> onError) {
        if (client == null) throw new IllegalArgumentException("client is required");
        this.client = client;
        this.keys = keys == null ? new MemoryKeyStore() : keys;
        this.transactions = transactions == null ? new MemoryTransactionStore() : transactions;
        this.onError = onError == null ? (e, ctx) -> { } : onError;
    }

    public Receiver on(String eventType, Handler handler) { return on(eventType, handler, 1); }

    public Receiver on(String eventType, Handler handler, int version) {
        if (handler == null) throw new IllegalArgumentException("handler is required");
        handlers.put(eventType, new Registration(handler, version));
        return this;
    }

    // Subscribes every registered event. New keys are saved when the key store is writable, and
    // always returned, for stores you manage yourself.
    public Map<String, String> subscribe(String webhookUrl) {
        Map<String, String> minted = new LinkedHashMap<>();
        for (Map.Entry<String, Registration> e : handlers.entrySet()) {
            String key = client.subscribe(e.getKey(), e.getValue().version(), webhookUrl).publicKey();
            minted.put(e.getKey(), key);
            if (keys instanceof WritableKeyStore w) w.set(e.getKey(), key);
        }
        return minted;
    }

    // Phase 1, fast: verify, parse, claim.
    public Accepted accept(byte[] rawBody, String signature, String idempotencyKey) {
        Map.Entry<String, String> match = null;
        Map<String, String> stored = keys.get();
        if (stored != null) for (Map.Entry<String, String> e : stored.entrySet()) {
            if (Signature.verify(rawBody, signature, e.getValue())) { match = e; break; }
        }
        if (match == null) return Accepted.refused(401);
        Signature.ParsedEvent evt;
        try {
            evt = Signature.parseEvent(rawBody, signature, match.getValue(), idempotencyKey);
        } catch (Signature.EventException e) {
            return Accepted.refused(400);
        }
        String eventType = match.getKey();
        if (!transactions.claim(evt.transactionId())) return new Accepted(200, () -> {}, eventType, evt.transactionId(), true);
        EventContext ctx = new EventContext(eventType, evt.transactionId(), idempotencyKey);
        return new Accepted(200, () -> run(evt, ctx), eventType, evt.transactionId(), false);
    }

    // Phase 2: the handler, one callback, and the claim settled (done, or released so a redelivery retries).
    private void run(Signature.ParsedEvent evt, EventContext ctx) {
        Registration registered = handlers.get(ctx.eventType());
        Map<String, Object> fields = null;
        Exception failure = null;
        try {
            if (registered != null) fields = registered.handler().handle(evt, ctx);
        } catch (Exception e) {
            if (e instanceof InterruptedException) Thread.currentThread().interrupt();
            failure = e;
        }
        try {
            if (failure != null) client.fail(evt, failure.getMessage() == null ? failure.getClass().getSimpleName() : failure.getMessage());
            else client.callback(evt, fields);
        } catch (ParspecClient.ParspecApiException e) {
            transactions.release(ctx.transactionId());
            onError.accept(e, ctx);
            return;
        }
        if (failure != null) {
            transactions.release(ctx.transactionId());
            onError.accept(failure, ctx);
        } else {
            transactions.done(ctx.transactionId());
        }
    }

    // Both phases in one call; returns the status to answer PM with.
    public int handle(byte[] rawBody, String signature, String idempotencyKey) {
        Accepted r = accept(rawBody, signature, idempotencyKey);
        r.process().run();
        return r.status();
    }

    private static final int MAX_BODY = 5 << 20;

    // A handler for the JDK's built-in server: answers PM and runs the event's function on `work`, so a slow
    // ERP call never holds up the server's request threads. Size the pool for how many events may run at once.
    //   ExecutorService work = Executors.newFixedThreadPool(8);
    //   HttpServer server = HttpServer.create(new InetSocketAddress(3000), 0);
    //   server.createContext("/parspec/webhook", receiver.httpHandler(work));
    //   server.start();
    public HttpHandler httpHandler(Executor work) {
        if (work == null) throw new IllegalArgumentException("an executor for the event functions is required");
        return exchange -> {
            try (exchange) {
                if (!"POST".equals(exchange.getRequestMethod())) {
                    exchange.getResponseHeaders().set("Allow", "POST");
                    exchange.sendResponseHeaders(405, -1);
                    return;
                }
                byte[] raw = exchange.getRequestBody().readNBytes(MAX_BODY + 1);
                if (raw.length > MAX_BODY) { exchange.sendResponseHeaders(413, -1); return; }
                var headers = exchange.getRequestHeaders();
                Accepted r;
                try {
                    r = accept(raw, headers.getFirst("X-Signature"), headers.getFirst("Idempotency-Key"));
                } catch (RuntimeException e) {   // a failing key or transaction store: answer 500, report it
                    exchange.sendResponseHeaders(500, -1);
                    onError.accept(e, new EventContext(null, null, null));
                    return;
                }
                if (r.status() == 200 && !r.duplicate()) {   // only a newly claimed event has work to run
                    try {
                        work.execute(r.process());
                    } catch (RejectedExecutionException e) {   // pool full or shut down: tell PM it failed, not that it's done
                        transactions.release(r.transactionId());
                        exchange.sendResponseHeaders(503, -1);
                        onError.accept(e, new EventContext(r.eventType(), r.transactionId(), null));
                        return;
                    }
                }
                exchange.sendResponseHeaders(r.status(), -1);
            }
        };
    }
}
