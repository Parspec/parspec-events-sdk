# Parspec SDK: PM events

Small libraries for receiving Parspec PM webhook events in your own service: subscribe, verify, and call back. One implementation per language, all tested against the same fixtures.

| Language | Branch | Folder on `main` | Dependencies |
|---|---|---|---|
| Node 18+ | `node` | `node/` | none |
| Python 3.10+ | `python` | `python/` | `cryptography` |
| C# / .NET 8+ | `csharp` | `csharp/` | none |
| Java 17+ | `java` | `java/` | none |

How the events work (subscribe, verify, deduplicate, callback): [PROTOCOL.md](PROTOCOL.md). Usage for each language is in its folder's README.

The Workato connector (`workato-connector`) implements the same protocol for Workato recipes.

## Try it locally: the PM playground

You can build and test a receiver without a PM org. The playground is a local stand-in for PM with a web page for sending mocked events:

```
node harness/playground.js                # then open http://localhost:4800
```

1. Point your SDK at `http://127.0.0.1:4800/platform-api/api/v1/` instead of PM. Any API key works.
2. Subscribe as you would against PM. The playground issues a signing key per subscription, the same way PM does, and lists it on the page.
3. Pick an event type, edit the body if you like, and click **Send**. The delivery is signed exactly as PM signs it, and your callback shows up under Activity.
4. Use **Send twice**, **Tampered body** and **Old key** to check that your receiver deduplicates and rejects bad signatures. A delivery your receiver never answers is flagged after 30 seconds.

It ships with a sanitized sample for each of the 17 event types (`fixtures/samples/`). To add your own, drop JSON files into a `mocks/` folder; they appear on the next refresh. Recorded deliveries from mock-erp work as-is.

To see it end to end, run the example receiver in a second terminal. It subscribes itself to the playground:

```
PARSPEC_BASE_URL=http://127.0.0.1:4800/platform-api/api/v1/ PARSPEC_API_KEY=dev \
  PARSPEC_EVENTS=tandemOrder.publishToErp:1,inventory.fetchPrice:2 node node/example-server.js
```

When your receiver works locally, switch the base URL to sandbox. The playground is for your machine only: it has no authentication, so never expose it on a public URL. Details: [harness/README.md](harness/README.md#playground).

## Branches

`main` is where all code is edited. Each language branch holds only that language, the fixtures, and a README combining the language guide and the protocol, so a client can take one branch into their project:

```
git clone -b csharp --single-branch <repo-url>
```

Don't commit to the language branches. After changing `main`, rebuild them:

```
scripts/build-branches.sh
```

It adds one commit to each branch whose content changed, and skips the rest.

## Harness

`harness/` runs all four SDKs through the same checks: unit tests, recorded deliveries, and a live org end to end (or a local fake PM). See [harness/README.md](harness/README.md).

```
node harness/run.js fixtures                 # every language's unit tests
node harness/run.js live --fake              # all four SDKs end to end against the playground
node --test harness/playground.test.js       # the playground's own end-to-end tests
```

## Tests

Each language on its own, from the repo root:

```
(cd node && node --test test.js)
(cd python && python3 -m unittest)
dotnet run --project csharp/Parspec.Events.Tests
(cd java && javac --release 17 -d out $(find src -name '*.java') && java -cp out com.parspec.events.FixturesTest)
```

All four run the files in `fixtures/`:

- `signatures.json`: signed bodies and whether each should verify. Covers tampered bodies, re-serialized JSON, a stale key, and empty or malformed signatures.
- `callbacks.json`: callback inputs and the exact request each SDK must send.
- `subscribe.json`: scripted request/response exchanges for subscribe, including the conflict retry.

A new language is done when it passes all three. `node fixtures/generate.js` regenerates the signature and callback fixtures with fresh test keys.
