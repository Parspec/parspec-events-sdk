"""Harness adapter; same contract as adapters/node.js."""
import base64
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "python"))
import parspec_events as sdk  # noqa: E402

q = json.load(sys.stdin)
b = base64.b64decode


def client():
    return sdk.Client(q["apiKey"], base_url=q["base"])


try:
    if q["op"] == "verify":
        out = [sdk.verify(b(c["body"]), c["signature"], c["publicKey"]) for c in q["cases"]]
    elif q["op"] == "callback":
        out = []
        for c in q["cases"]:
            p = sdk.parse_event(b(c["body"]), {"X-Signature": c["signature"]}, q["publicKey"])
            client().callback(p["event"], c["fields"])
            out.append(p["transaction_id"])
    elif q["op"] == "subscribe":
        out = client().subscribe(q["eventType"], q["version"], q["webhookUrl"])
    elif q["op"] == "unsubscribe":
        out = [r["status"] for r in client().unsubscribe(q["eventType"], q.get("version"))]
    else:
        raise ValueError(f"unknown op {q['op']}")
    print(json.dumps(out), end="")
except Exception as e:
    print(json.dumps({"error": str(e), "status": getattr(e, "status", None)}), end="")
    sys.exit(1)
