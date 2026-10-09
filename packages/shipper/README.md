# @vigil/shipper

Ships Vigil's stored telemetry to the telemetry relay (`apps/relay`): a
library the desktop app wires in and runs while the opt-in `telemetry.relay`
setting is on. No daemon, no Electron dependency — pure TypeScript over
injected edges.

## How it ships

- **Reads** the app's own store through the thin `ShipperStore` interface
  (keyset reads by `(ts, id)` for events, alerts and actions; a versioned
  rules snapshot). The app implements it against `vigil.db`; the engine owns
  no storage. Its only durable state is one cursor, which the app persists
  from the `onAck` callback.
- **Redacts every body** before it becomes a record: the wiring passes
  `redactValue(b, localNames())` from `@vigil/ai/redact` — the same pass
  Vigil's own AI gets. The sensor's `raw` record never ships.
- **Batches** at the house discipline: every second, or 500 records, whichever
  comes first, merged across streams by `(ts, id)`.
- **Pushes** one gzipped JSON ingest batch per cycle through the injected
  `ShipperTransport` (`HttpShipperTransport` wraps a fetch with the bearer
  token, `Content-Encoding: gzip` and a 5 s timeout — the feed importer's
  `FetchLike` pattern).
- **Advances the cursor only on the relay's ack.** A crash replays the batch;
  stable record ids mean the relay counts duplicates and nothing is lost.
- **Backs off** 5 s doubling to 5 min, jittered, when a push fails retryably;
  halts (and says why in `status()`) on a revoked token, a deterministic
  relay rejection, or a redacted body that failed the wire schema.
- **Detects pruning gaps**: when the store's oldest surviving event has moved
  past the cursor, unsent records were dropped; the engine notes it, raises it
  through `onGap` (the wiring's house alert channel), and moves on.

## Use

```ts
import { RelayShipper, HttpShipperTransport } from '@vigil/shipper';

const shipper = new RelayShipper({
  deviceId,
  store, // the app's read-only view of vigil.db
  transport: new HttpShipperTransport({ endpoint: relayUrl, token: () => keyStore.get('relay') }),
  redact: (b) => redactValue(b, localNames()),
  cursor, // loaded from the settings store
  onAck: (cursor) => settings.put('telemetry.relay.cursor', cursor),
});
shipper.start(); // and shipper.stop() when the setting turns off
```

The wire schemas in `src/wire.ts` mirror the relay contract that lives in
`@vigil/core` (see the wire-schemas work item); they move to an import of
`@vigil/core` once that lands on the release branch.
