"""Runs the shared fixtures in ../fixtures. `python3 -m unittest`"""

import json
import pathlib
import pickle
import unittest

from parspec_events import (Client, EventError, MemoryKeys, MemoryTransactions, ParspecApiError, Receiver, SignatureError,
                            parse_event, verify)

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


class TestStores:
    """A store the test writes itself, as a developer would: proves the interfaces are all the receiver needs."""

    def __init__(self, c):
        self.key_map = {t: (FX / "keys" / f).read_text() for t, f in c["keys"].items()}
        self.processing, self.done_ = set(c.get("processing", [])), set(c.get("done", []))

    def get(self):  # read-only key store, like env vars: no set()
        return self.key_map

    def claim(self, t):
        if t in self.processing or t in self.done_:
            return False
        self.processing.add(t)
        return True

    def done(self, t):
        self.processing.discard(t)
        self.done_.add(t)

    def release(self, t):
        self.processing.discard(t)


class Receivers(unittest.TestCase):
    def test_scenarios(self):
        for c in load("receiver.json"):
            with self.subTest(c["name"]):
                send, sent = fake_send([{"status": s, "body": {}} for s in c.get("callbackResponses", [])])
                stores = TestStores(c)
                receiver = Receiver(Client("k", base_url=BASE, send=send), keys=stores, transactions=stores)
                calls = []
                for event_type, behaviours in c["handlers"].items():
                    def handler(event, ctx, behaviours=behaviours, n=[0]):
                        calls.append({"eventType": ctx["event_type"], "transactionId": ctx["transaction_id"]})
                        b = behaviours[min(n[0], len(behaviours) - 1)]
                        n[0] += 1
                        if "throw" in b:
                            raise RuntimeError(b["throw"])
                        return b["return"]
                    receiver.on(event_type, handler)
                got = [receiver.handle(d["body"].encode(), {"X-Signature": d["signature"]}) for d in c["deliveries"]]
                self.assertEqual(got, [d["status"] for d in c["deliveries"]])
                self.assertEqual(calls, c["expect"]["calls"])
                self.assertEqual([x["body"] for x in sent], c["expect"]["callbacks"])
                self.assertEqual(sorted(stores.done_), sorted(c["expect"]["done"]))
                self.assertEqual(sorted(stores.processing), sorted(c["expect"]["processing"]))

    def test_subscribe_stores_keys_and_returns_them(self):
        send, calls = fake_send([{"status": 200, "body": {}}, {"status": 200, "body": {}}, {"status": 200, "body": {"publicKey": "KEY-A"}},
                                 {"status": 200, "body": {}}, {"status": 200, "body": {}}, {"status": 200, "body": {"publicKey": "KEY-B"}}])
        keys = MemoryKeys()
        receiver = Receiver(Client("k", base_url=BASE, send=send), keys=keys)

        @receiver.on("inventory.fetchPrice", version=2)
        def price(event, ctx):
            return {}

        receiver.on("tandemOrder.publishToErp", lambda e, c: None)
        self.assertEqual(receiver.subscribe("https://erp.example/hook"), {"inventory.fetchPrice": "KEY-A", "tandemOrder.publishToErp": "KEY-B"})
        self.assertEqual(keys.get(), {"inventory.fetchPrice": "KEY-A", "tandemOrder.publishToErp": "KEY-B"})
        self.assertEqual([(c["body"]["event_type"], c["body"]["event_version"]) for c in calls if c["method"] == "PUT"],
                         [("inventory.fetchPrice", 2), ("tandemOrder.publishToErp", 1)])

    def test_read_only_key_store_gets_keys_back(self):
        class EnvKeys:
            def get(self):
                return {}
        send, _ = fake_send([{"status": 200, "body": {}}, {"status": 200, "body": {}}, {"status": 200, "body": {"publicKey": "KEY-A"}}])
        receiver = Receiver(Client("k", base_url=BASE, send=send), keys=EnvKeys()).on("tandemOrder.publishToErp", lambda e, c: None)
        self.assertEqual(receiver.subscribe("https://erp.example/hook"), {"tandemOrder.publishToErp": "KEY-A"})

    def test_memory_transactions_lease(self):
        import time
        t = MemoryTransactions(lease_seconds=0.02)
        self.assertTrue(t.claim("a"))
        self.assertFalse(t.claim("a"))
        time.sleep(0.03)
        self.assertTrue(t.claim("a"), "lease expired")
        t.done("a")
        self.assertFalse(t.claim("a"))

    def test_accept_answers_before_the_handler_runs(self):
        c = load("receiver.json")[0]
        stores = TestStores(c)
        ran = []
        send, _ = fake_send()
        receiver = Receiver(Client("k", base_url=BASE, send=send), keys=stores, transactions=stores)
        receiver.on("inventory.fetchPrice", lambda e, ctx: ran.append(1))
        r = receiver.accept(c["deliveries"][0]["body"].encode(), {"x-signature": c["deliveries"][0]["signature"]})
        self.assertEqual((r.status, r.event_type, ran), (200, "inventory.fetchPrice", []))
        r.process()
        self.assertEqual(ran, [1])


class Handlers(unittest.TestCase):
    """receiver.wsgi() and receiver.asgi(): answer PM first, then run the function."""

    def setUp(self):
        self.c = load("receiver.json")[0]
        self.delivery = self.c["deliveries"][0]
        self.send, self.sent = fake_send()
        stores = TestStores(self.c)
        self.receiver = Receiver(Client("k", base_url=BASE, send=self.send), keys=stores, transactions=stores)

    def test_environments_local_and_uat(self):
        send, calls = fake_send()
        Client("k", environment="local", send=send).callback({"eventTransactionID": "t"})
        Client("k", environment="uat", send=send).callback({"eventTransactionID": "t"})
        self.assertEqual([c["url"] for c in calls], ["http://127.0.0.1:4800/platform-api/api/v1/integrations/events/callback",
                                                     "https://uat-platform.parspec.io/platform-api/api/v1/integrations/events/callback"])

    def test_wsgi_over_real_http(self):
        import threading
        import urllib.error
        import urllib.request
        from wsgiref.simple_server import WSGIRequestHandler, make_server

        class Quiet(WSGIRequestHandler):
            def log_message(self, *args):
                pass

        gate, ran = threading.Event(), threading.Event()

        def price(event, ctx):
            gate.wait(5)
            ran.set()
            return {"data": {"items": []}}
        self.receiver.on("inventory.fetchPrice", price)
        server = make_server("127.0.0.1", 0, self.receiver.wsgi(), handler_class=Quiet)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        url = f"http://127.0.0.1:{server.server_port}/webhook"

        def post(body, method="POST"):
            req = urllib.request.Request(url, data=body.encode() if body is not None else None, method=method,
                                         headers={"X-Signature": self.delivery["signature"]})
            try:
                with urllib.request.urlopen(req, timeout=5) as res:
                    return res.status
            except urllib.error.HTTPError as e:
                with e:
                    return e.code
        try:
            self.assertEqual(post(self.delivery["body"]), 200, "answered while the function is still waiting")
            self.assertFalse(ran.is_set())
            gate.set()
            self.assertTrue(ran.wait(5))
            for _ in range(100):
                if self.sent:
                    break
                threading.Event().wait(0.01)
            self.assertEqual(self.sent[0]["body"]["EventStatus"], "success")
            self.assertEqual(post(self.delivery["body"].replace('"data":', '"data" :')), 401, "tampered")
            self.assertEqual(post(None, "GET"), 405)
        finally:
            server.shutdown()
            server.server_close()

    def test_asgi_answers_then_runs(self):
        import asyncio
        messages = []
        self.receiver.on("inventory.fetchPrice", lambda e, ctx: messages.append("function ran"))
        body = self.delivery["body"].encode()

        async def run(method="POST"):
            chunks = [{"type": "http.request", "body": body[:10], "more_body": True}, {"type": "http.request", "body": body[10:]}]

            async def receive():
                return chunks.pop(0)

            async def send(m):
                messages.append(m.get("status", m["type"]))
            scope = {"type": "http", "method": method, "headers": [(b"x-signature", self.delivery["signature"].encode())]}
            await self.receiver.asgi()(scope, receive, send)
        asyncio.run(run())
        self.assertEqual(messages, [200, "http.response.body", "function ran"])
        self.assertEqual(self.sent[0]["body"]["EventStatus"], "success")
        messages.clear()
        asyncio.run(run("GET"))
        self.assertEqual(messages[0], 405)

    def test_asgi_app_is_not_a_plain_function(self):
        # Starlette's add_route calls a plain function as a request handler (fn(request)), not as an ASGI app.
        import inspect
        app = self.receiver.asgi()
        self.assertFalse(inspect.isfunction(app) or inspect.ismethod(app))


if __name__ == "__main__":
    unittest.main()
