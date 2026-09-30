# Parspec PM events: Python

Subscribe to Parspec PM events, verify webhook signatures, and send callbacks. Python 3.9+. Needs `cryptography` (the standard library can't verify RSA); HTTP uses the standard library.

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
