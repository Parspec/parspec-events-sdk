# Parspec PM events: Java

Subscribe to Parspec PM events, verify webhook signatures, and send callbacks. Java 17+ (Spring Boot 3 or plain Java), no dependencies.

Copy `src/main/java/com/parspec/events/` into your project.

```java
import com.parspec.events.*;

ParspecClient client = new ParspecClient(apiKey, "sandbox");
String publicKey = client.subscribe("tandemOrder.publishToErp", 1, "https://your-host/webhook").publicKey();

// Spring Boot: take the body as byte[] so the signature is checked against the exact bytes PM sent.
@PostMapping("/webhook")
public ResponseEntity<Void> webhook(@RequestBody byte[] body,
                                    @RequestHeader(value = "X-Signature", required = false) String sig,
                                    @RequestHeader(value = "Idempotency-Key", required = false) String idem) {
    Signature.ParsedEvent evt;
    try { evt = Signature.parseEvent(body, sig, publicKey, idem); }
    catch (Signature.SignatureException e) { return ResponseEntity.status(401).build(); }
    // hand evt to a background worker, then:
    //   client.callback(evt, Map.of("orderId", "SO-123"));   or   client.fail(evt, "Credit check failed");
    return ResponseEntity.ok().build();
}
```

`evt.event()` is the parsed envelope as maps and lists. To bind it to your own classes, parse `body` again with Jackson after verifying. To use your own HTTP client, pass a `ParspecClient.Transport`.

## Receiver

Register a function per event type; the receiver verifies, routes, deduplicates and calls back. How it works, and how to store keys and transactions in production: [PROTOCOL.md](../PROTOCOL.md#the-receiver-and-where-to-store-things).

```java
Receiver.KeyStore envKeys = () -> parseJson(System.getenv("PARSPEC_KEYS"));   // read-only: env vars
Receiver receiver = new Receiver(new ParspecClient(apiKey, "sandbox"), envKeys, myTransactions, null)   // TransactionStore: Postgres, Redis
    .on("tandemOrder.publishToErp", (event, ctx) -> {
        String orderId = erp.createSalesOrder(event.event().get("data"), ctx.transactionId());   // idempotency key
        return Map.of("orderId", orderId);   // throw to send an error callback
    });

Map<String, String> newKeys = receiver.subscribe("https://erp.example/parspec/webhook");   // store these

// Spring Boot: raw body, answer first, then process.
@PostMapping("/parspec/webhook")
public ResponseEntity<Void> webhook(@RequestBody byte[] body,
                                    @RequestHeader(value = "X-Signature", required = false) String sig,
                                    @RequestHeader(value = "Idempotency-Key", required = false) String idem) {
    Receiver.Accepted r = receiver.accept(body, sig, idem);
    executor.execute(r.process());   // a TaskExecutor or @Async
    return ResponseEntity.status(r.status()).build();
}
```

`Receiver.MemoryKeyStore` and `Receiver.MemoryTransactionStore` are the in-memory versions for development. Implement `WritableKeyStore` if `subscribe()` should save keys itself. The receiver is thread-safe to share once its handlers are registered.

## Use as a git submodule

The `java` branch of this repo holds only this SDK, so it can be added to your project directly:

```
git submodule add -b java <repo-url> vendor/parspec-events
```

Then add `vendor/parspec-events/java/src/main/java` as a source folder: the `build-helper-maven-plugin` `add-source` goal in Maven, or `sourceSets.main.java.srcDir 'vendor/parspec-events/java/src/main/java'` in Gradle.

Pull updates with `git submodule update --remote`. Your project stays on the commit it has until you do.

## Tests

```
cd java && javac --release 17 -d out $(find src -name '*.java') && java -cp out com.parspec.events.FixturesTest
```

Runs the shared cases in `../fixtures/`.
