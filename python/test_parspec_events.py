"""Runs the shared fixtures in ../fixtures. `python3 -m unittest`"""

import json
import pathlib
import pickle
import unittest

from parspec_events import Client, EventError, ParspecApiError, SignatureError, parse_event, verify

FX = pathlib.Path(__file__).resolve().parent.parent / "fixtures"
BASE = "https://pm.example/platform-api/api/v1/"


def load(name):
    return json.loads((FX / name).read_text(encoding="utf-8"))


def fake_send(responses=()):
    calls = []

    def send(method, url, headers, body):
        calls.append({"method": method, "url": url, "headers": headers, "body": json.loads(body)})
        r = responses[len(calls) - 1] if len(calls) <= len(responses) else {"status": 200, "body": {}}
        if r.get("network"):
            raise ConnectionRefusedError("connection refused")
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
                for headers in ({"x-signature": c["signature"], "idempotency-key": "idem-1"},
                                {"X-Signature": c["signature"], "Idempotency-Key": "idem-1"}):
                    if not c["valid"]:
                        with self.assertRaises(SignatureError):
                            parse_event(raw, headers, key)
                    elif c.get("envelope") is False:
                        with self.assertRaises(EventError):
                            parse_event(raw, headers, key)
                    else:
                        parsed = parse_event(raw, headers, key)
                        self.assertEqual(parsed["transaction_id"], parsed["event"]["eventTransactionID"])
                        self.assertEqual(parsed["idempotency_key"], "idem-1")


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
                if "method" not in c["expect"]:
                    self.assertEqual(calls, [], "no request may be sent")
                    continue
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


class ClientBehaviour(unittest.TestCase):
    def test_constructor_environments_and_trailing_slash(self):
        with self.assertRaises(ValueError):
            Client("")
        with self.assertRaises(ValueError):
            Client("k", environment="nowhere")
        send, calls = fake_send()
        Client("k", environment="sandbox", send=send).callback({"eventTransactionID": "t"})
        Client("k", base_url=BASE[:-1], send=send).callback({"eventTransactionID": "t"})
        self.assertEqual([c["url"] for c in calls], [
            "https://platform-sandbox.parspec.io/platform-api/api/v1/integrations/events/callback",
            BASE + "integrations/events/callback"])

    def test_unsubscribe_explicit_version(self):
        send, calls = fake_send()
        self.assertEqual(Client("k", base_url=BASE, send=send).unsubscribe("quote.created", 2), [{"version": 2, "status": 200}])
        self.assertEqual([c["body"] for c in calls], [{"event_type": "quote.created", "event_version": 2}])

    def test_default_transport_timeout_and_network_errors(self):
        # Nothing listens on port 9 (discard): the real urllib transport must raise the SDK error, status 0.
        with self.assertRaises(ParspecApiError) as ctx:
            Client("k", base_url="http://127.0.0.1:9/platform-api/api/v1/", timeout=2).callback({"eventTransactionID": "t"})
        self.assertEqual(ctx.exception.status, 0)

    def test_api_error_pickles(self):
        e = pickle.loads(pickle.dumps(ParspecApiError("boom", 500, {"a": 1})))
        self.assertEqual((str(e), e.status, e.body), ("boom", 500, {"a": 1}))


if __name__ == "__main__":
    unittest.main()
