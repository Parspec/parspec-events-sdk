# Conformance harness

Runs all four SDKs through the same checks. Needs the four toolchains (Node 18+, Python 3.9+ with `cryptography`, .NET 10 SDK, JDK 17+). From the repo root:

| Command | What it checks | Network |
|---|---|---|
| `node harness/run.js fixtures` | Each language's unit tests against `fixtures/` | none |
| `node harness/run.js replay --events <dir>` | Recorded deliveries through all four SDKs: signature (real, tampered, wrong key) and callback, compared with the callback that was actually sent | none |
| `node harness/run.js live --fake` | The live flow against a local fake PM | none |
| `node harness/run.js live --events a,b,c` | A real org, end to end | PM + a public URL |

`--only node,java` limits the languages. Exit code is non-zero when any check fails.

## Replay

`--events` takes a directory in mock-erp's `runtime-data/<slug>` layout:

- `events/*.json`: delivered envelopes
- `callbacks/<first 8 chars of the transaction id>.json`: `{ "sent": { ... } }`, the callback the receiver sent

The recordings keep the parsed event, not PM's signature, so the harness re-signs each body with a throwaway key. Real PM signatures are covered by live mode. Recorded org data never goes in this repo.

```
node harness/run.js replay --events ../Workato/runtime-data/cs_sandbox_erp
```

## Live

For each event, one language (in turn) subscribes it to `PARSPEC_WEBHOOK_URL/webhook/<event>`. The harness then:

1. Checks the catalog no longer lists the event as available.
2. Waits for you to trigger the events in PM.
3. Has all four languages verify each delivery's real signature, and reject a tampered copy.
4. Sends one callback per transaction from the subscribing language.
5. Unsubscribes everything and checks the catalog lists the events again.

It receives on `127.0.0.1:9477` (`PORT` to change). Expose that port publicly, for example on the Tailscale funnel:

```
tailscale funnel --bg --set-path /sdk http://127.0.0.1:9477

PARSPEC_API_KEY=<org key> \
PARSPEC_ENV=sandbox \
PARSPEC_WEBHOOK_URL=https://<machine>.ts.net/sdk \
node harness/run.js live --events tandemOrder.publishToErp,inventory.fetchPrice,receivingTicket.publishToErp,deliveryTicket.publishToErp
```

Clean up afterwards with `tailscale funnel --set-path /sdk off`.

Things to know:

- **Subscribing takes events from the org's current receiver.** Every subscribe mints a new signing key, and the current receiver stops getting those events. When the run ends the events are unsubscribed, not handed back. Resubscribe the real receiver afterwards; for mock-erp, turn the events off and on again in the console, then Apply.
- **Production is refused** unless you pass `--allow-production`.
- **Other options:**
  - `event:version` overrides the payload version. The default is v2 for `inventory.fetchPrice`, `quote.*` and `bom.publishToOrderSystem`, and v1 for everything else.
  - `--wait <sec>` is how long to wait for deliveries (default 600).
  - `--keep` leaves the subscriptions in place.
  - Ctrl-C stops waiting and still cleans up.
- **The callback is a plain success acknowledgement** with no order ids. On an event like `inventory.fetchPrice`, PM may show that as missing data.

## Adapters

`adapters/` holds one small program per language. Each takes a single JSON request on stdin and prints a JSON reply:

| Op | Does |
|---|---|
| `verify` | check signatures |
| `callback` | parse a delivery and send its callback |
| `subscribe` | subscribe an event |
| `unsubscribe` | unsubscribe an event |

The contract is documented at the top of `adapters/node.js`. A new language is added by writing its adapter and adding it to `ADAPTERS` in `run.js`.
