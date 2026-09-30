# Parspec SDK: PM events

Small libraries for receiving Parspec PM webhook events in your own service: subscribe, verify, and call back. One implementation per language, all tested against the same fixtures.

| Language | Branch | Folder on `main` | Dependencies |
|---|---|---|---|
| Node 18+ | `node` | `node/` | none |
| Python 3.9+ | `python` | `python/` | `cryptography` |
| C# / .NET 8+ | `csharp` | `csharp/` | none |
| Java 17+ | `java` | `java/` | none |

How the events work (subscribe, verify, deduplicate, callback): [PROTOCOL.md](PROTOCOL.md). Usage for each language is in its folder's README.

The Workato connector (`workato-connector`) implements the same protocol for Workato recipes.

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
node harness/run.js fixtures
node harness/run.js live --fake
node harness/playground.js      # web page for sending mocked events to your receiver
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
