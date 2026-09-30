"""Runs the shared fixtures in ../fixtures. `python3 -m unittest`"""

import json
import pathlib
import unittest

from parspec_events import Client, ParspecApiError, SignatureError, parse_event, verify

FX = pathlib.Path(__file__).resolve().parent.parent / "fixtures"
BASE = "https://pm.example/platform-api/api/v1/"


def load(name):
    return json.loads((FX / name).read_text(encoding="utf-8"))


def fake_send(responses=()):
    calls = []

    def send(method, url, headers, body):
        calls.append({"method": method, "url": url, "headers": headers, "body": json.loads(body)})
        r = responses[len(calls) - 1] if len(calls) <= len(responses) else {"status": 200, "body": {}}
        return r["status"], json.dumps(r["body"])

    return send, calls


class Signatures(unittest.TestCase):
    def test_cases(self):
        for c in load("signatures.json"):
            with self.subTest(c["name"]):
                key = (FX / "keys" / c["key"]).read_text()
                raw = c["body"].encode("utf-8")
                self.assertEqual(verify(raw, c["signature"], key), c["valid"])
                # Frameworks differ on header-name case; both must work.
                if c["name"] == "valid":
                    headers = {"x-signature": c["signature"], "idempotency-key": "idem-1"}
                else:
                    headers = {"X-Signature": c["signature"], "Idempotency-Key": "idem-1"}
                if c["valid"]:
                    parsed = parse_event(raw, headers, key)
                    self.assertEqual(parsed["transaction_id"], parsed["event"]["eventTransactionID"])
                    self.assertEqual(parsed["idempotency_key"], "idem-1")
                else:
                    with self.assertRaises(SignatureError):
                        parse_event(raw, headers, key)


class Callbacks(unittest.TestCase):
    def test_cases(self):
        for c in load("callbacks.json"):
            with self.subTest(c["name"]):
                send, calls = fake_send([c["response"]] if "response" in c else [])
                client = Client("k", base_url=BASE, send=send)

                def run():
                    if c["call"] == "error":
                        client.fail(c["event"], c["message"])
                    else:
                        client.callback(c["event"], c["fields"])

                if "error" in c["expect"]:
                    with self.assertRaises(ParspecApiError) as ctx:
                        run()
                    self.assertEqual(ctx.exception.status, c["expect"]["error"])
                else:
                    run()
                self.assertEqual(len(calls), 1)
                self.assertEqual(calls[0]["method"], c["expect"]["method"])
                self.assertEqual(calls[0]["url"], c["expect"]["url"])
                self.assertEqual(calls[0]["body"], c["expect"]["body"])
                self.assertEqual(calls[0]["headers"]["x-api-key"], "k")


class Subscribe(unittest.TestCase):
    def test_cases(self):
        for c in load("subscribe.json"):
            with self.subTest(c["name"]):
                send, calls = fake_send([x["response"] for x in c["exchange"]])
                client = Client("k", base_url=BASE, send=send)
                a = c["args"]
                if "error" in c["expect"]:
                    with self.assertRaises(ParspecApiError) as ctx:
                        client.subscribe(a["eventType"], a["version"], a["webhookUrl"])
                    self.assertEqual(ctx.exception.status, c["expect"]["error"])
                else:
                    self.assertEqual(client.subscribe(a["eventType"], a["version"], a["webhookUrl"]), c["expect"])
                got = [{"method": x["method"], "path": x["url"][len(BASE):], "body": x["body"]} for x in calls]
                self.assertEqual(got, [x["request"] for x in c["exchange"]])


if __name__ == "__main__":
    unittest.main()
