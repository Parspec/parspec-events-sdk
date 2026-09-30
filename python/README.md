# Parspec PM events: Python

Subscribe to Parspec PM events, verify webhook signatures, and send callbacks. Python 3.10+. Needs `cryptography` (the standard library can't verify RSA); HTTP uses the standard library.

Copy `parspec_events.py` into your project, or `pip install ./python`.

```python
from parspec_events import Client, parse_event

client = Client(api_key, environment="sandbox")
public_key = client.subscribe("tandemOrder.publishToErp", 1, "https://your-host/webhook")["publicKey"]

# in your webhook handler, with the raw body bytes:
parsed = parse_event(raw_body, headers, public_key)  # raises SignatureError
client.callback(parsed["event"], {"orderId": "SO-123"})
# or: client.fail(parsed["event"], "Credit check failed")
```

Raw body: `request.get_data()` in Flask, `await request.body()` in FastAPI, `request.body` in Django.

## Receiver

Register a function per event type; the receiver verifies, routes, deduplicates and calls back. How it works, and how to store keys and transactions in production: [PROTOCOL.md](../PROTOCOL.md#the-receiver-and-where-to-store-things).

```python
import json, os
from parspec_events import Client, Receiver

class EnvKeys:                       # read-only key store: env vars
    def get(self):
        return json.loads(os.environ.get("PARSPEC_KEYS", "{}"))

receiver = Receiver(Client(os.environ["PARSPEC_API_KEY"], environment="sandbox"),
                    keys=EnvKeys(), transactions=my_transactions)   # claim / done / release, e.g. Postgres or Redis

@receiver.on("tandemOrder.publishToErp")
def publish(event, ctx):
    so = erp.create_sales_order(event["data"], idempotency_key=ctx["transaction_id"])
    return {"orderId": so.id}        # the success callback; raise to send an error callback

new_keys = receiver.subscribe("https://erp.example/parspec/webhook")   # store these: PARSPEC_KEYS

# FastAPI: raw body, answer first, then process.
@app.post("/parspec/webhook")
async def webhook(request: Request, background: BackgroundTasks):
    r = receiver.accept(await request.body(), request.headers)
    background.add_task(r.process)
    return Response(status_code=r.status)
```

`MemoryKeys` and `MemoryTransactions` are the in-memory versions for development. `on_error(err, ctx)` is called when a handler or callback fails.

## Use as a git submodule

The `python` branch of this repo holds only this SDK, so it can be added to your project directly:

```
git submodule add -b python <repo-url> vendor/parspec-events
pip install -e vendor/parspec-events/python
```

Pull updates with `git submodule update --remote`. Your project stays on the commit it has until you do.

## Tests

```
cd python && python3 -m unittest
```

Runs the shared cases in `../fixtures/`.
