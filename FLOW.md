# Event flow and key validation

How a PM event gets from PM to your ERP and back, and how each delivery's signing key is checked. The rules themselves are in [PROTOCOL.md](PROTOCOL.md); this is the same thing as diagrams.

## The whole flow

```mermaid
sequenceDiagram
    autonumber
    participant You as Your service (SDK)
    participant Keys as Key store
    participant PM as Parspec PM
    participant ERP as Your ERP

    Note over You,PM: Once per event type
    You->>PM: DELETE integrations/events/unsubscribe (v1 and v2)
    You->>PM: PUT integrations/events/subscribe {event_type, event_version, webhook_url}
    alt 400 "an active subscription already exists"
        You->>PM: DELETE the version the error names
        You->>PM: PUT subscribe again (at most 3 retries)
    end
    PM-->>You: 200 { publicKey }
    You->>Keys: set(eventType, publicKey)

    Note over PM,You: Every delivery
    PM->>You: POST webhook_url (raw body, X-Signature, Idempotency-Key)
    You->>Keys: get()
    You->>You: Verify signature, parse, claim eventTransactionID
    You-->>PM: 200 / 400 / 401 (within 10 s)
    You->>ERP: Your handler for the event type
    ERP-->>You: ERP ids
    You->>PM: POST {base}/callback_url {EventTransactionID, EventStatus, ...}
    PM-->>You: 2xx (one callback per transaction, within 10 min)
```

## Subscribe: where the keys come from

Every subscribe mints a new RSA key pair in PM and returns the public half. Deliveries are signed with the new key from then on, so the old key stops verifying.

```mermaid
flowchart TD
    A["receiver.subscribe(webhookUrl)"] --> B["For each registered event type"]
    B --> C["DELETE unsubscribe v1 and v2"]
    C --> D["PUT subscribe"]
    D --> E{Response}
    E -- "400 already exists, retries < 3" --> F["DELETE the version named in the error"]
    F -- "200" --> D
    F -- "not 200" --> X["ParspecApiError"]
    E -- "200 with a non-empty publicKey" --> G{"keys.set exists?"}
    E -- "anything else" --> X
    G -- yes --> H["keys.set(eventType, publicKey)"]
    G -- "no (read-only store, e.g. env vars)" --> I["Returned to you: update the env and restart"]
    H --> J["Every server must load the new key"]
    I --> J
```

## Receiving a delivery

`accept` is the fast phase that decides the HTTP answer; `process` runs after the answer is sent.

```mermaid
flowchart TD
    R["POST /parspec/webhook"] --> M{POST?}
    M -- no --> S405["405"]
    M -- yes --> RAW{"Raw body available?"}
    RAW -- "already parsed by a JSON middleware" --> S500["500: mount before the body parser"]
    RAW -- "over 5 MB" --> S413["413"]
    RAW -- yes --> K["keys.get(): every stored event type's public key"]
    K --> V{"Does any stored key verify X-Signature over the raw bytes?"}
    V -- no --> S401["401"]
    V -- "yes: the matching key names the event type" --> P{"Body is a JSON object with a non-empty eventTransactionID?"}
    P -- no --> S400["400"]
    P -- yes --> C{"transactions.claim(txid)"}
    C -- "false: done, or another worker holds it" --> DUP["200, nothing else"]
    C -- true --> OK["200"]
    OK --> RUN["process(): run the handler for that event type"]
```

## Key validation

`verify(rawBody, signature, publicKeyPem)` is the only check on who sent a delivery. It returns true or false and never throws. All four SDKs behave the same way, and `fixtures/signatures.json` pins every branch below.

```mermaid
flowchart TD
    IN["verify(rawBody, X-Signature, publicKeyPem)"] --> S{"Signature present and non-empty?"}
    S -- no --> F["false"]
    S -- yes --> PEM{"Key parses as a PEM public key?"}
    PEM -- "no (missing, garbage, not-a-key.pem)" --> F
    PEM -- yes --> RSA{"Is it an RSA key?"}
    RSA -- "no (e.g. ec.pem)" --> F
    RSA -- yes --> B64{"Signature is valid base64?"}
    B64 -- no --> F
    B64 -- yes --> SIG{"RSA-SHA256 PKCS#1 v1.5 verifies over the exact raw bytes?"}
    SIG -- "no (tampered body, re-serialized JSON, stale key, other.pem)" --> F
    SIG -- yes --> T["true"]
```

What makes a signature fail, and what to do about it:

| Cause | Why it fails | Fix |
|---|---|---|
| Body went through a JSON parser first | Re-serialized JSON has different bytes | Pass the bytes exactly as received (`express.raw()`, or mount the SDK handler before any parser) |
| Stale key | You resubscribed and PM now signs with the new key | Reload keys on every server after each subscribe |
| Key for a different event | No stored key matches, so the delivery can't be routed | Store one key per event type, from that event's subscribe |
| Wrong environment | Sandbox keys don't verify production deliveries | Subscribe and store keys per environment |
| Not from PM | Nobody else holds PM's private key | Nothing: the 401 is correct |

### Routing by key

Several event types can share one webhook URL. The delivery doesn't say which event it is in a header, so the receiver tries each stored key in turn; the first that verifies identifies the event type. That's why each event type needs its own key in the store, and why a stale key surfaces as a 401 rather than a misrouted event.

```mermaid
flowchart LR
    D["Delivery + X-Signature"] --> K1{"tandemOrder.publishToErp key"}
    K1 -- verifies --> H1["tandemOrder.publishToErp handler"]
    K1 -- no --> K2{"inventory.fetchPrice key"}
    K2 -- verifies --> H2["inventory.fetchPrice handler"]
    K2 -- no --> KN{"... remaining keys"}
    KN -- none verify --> U["401"]
```

The keys are **public** keys, so storing them isn't a secret-handling problem: env vars, a config file or a database row are fine. The secret is your PM API key, which the SDK sends only to the configured PM origin.

## After the answer: handler, callback, settle

```mermaid
stateDiagram-v2
    [*] --> Claimed: claim(txid) = true
    Claimed --> Handler: 200 sent to PM
    Handler --> SuccessCallback: returns fields (or nothing)
    Handler --> ErrorCallback: throws (message shown to the PM user)
    SuccessCallback --> Done: callback 2xx
    ErrorCallback --> Released: callback 2xx
    SuccessCallback --> Released: callback fails
    ErrorCallback --> Released: callback fails
    Claimed --> Released: lease expires (15 min, worker died)
    Done --> [*]: repeat deliveries get 200 and nothing else
    Released --> Claimed: a redelivery retries
```

The callback always carries `EventTransactionID` and `EventStatus` set by the SDK, after your fields, so a handler can't forge them. A `callback_url` that's an absolute URL on another host is refused before anything is sent, because the API key goes with every callback.
