# Alert rules

Detection data, not code. Each `*.json` file declares one rule; the daemon's
evaluator (src/rules.c) is a fixed consumer — rules change what it flags,
never how the daemon behaves. Files load in sorted filename order; one bad
file fails the whole load at startup (loudly, with the path and reason), so
a typo can never silently disable a rule mid-stream.

## Schema

| Field         | Type   | Notes                                                                                                                                                   |
| ------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | string | required; syslog-safe identifier, unique across the directory; appears as the SD param `rule=` in VIGALERT messages                                     |
| `description` | string | optional; human context, never parsed                                                                                                                   |
| `kind`        | string | required; one of the event kinds the evaluator matches: `process.exec`, `file`, `network.listen`, `privilege.change`, `kernel.module`, `monitor.health` |
| `severity`    | string | required; `critical` or `warning` — becomes the RFC 5424 severity of the VIGALERT message (PRI 34 / 36 at facility 4)                                   |
| `match`       | object | required; at least one matcher, keyed per kind below                                                                                                    |

Matcher keys by kind — unknown keys are load errors:

- `process.exec`: `pathPrefixes` (absolute, segment-aligned: `/tmp` matches
  `/tmp/x` and `/tmp`, never `/tmpfactory`), `escalationWindowMs` (an exec
  by a task whose euid became 0 from nonzero within this many
  milliseconds, measured on the record's own monotonic timeline).
- `file`: `pathPrefixes` (segment-aligned as above), `pathSuffixes`
  (final path segment, e.g. `.service`). Renames match when either
  endpoint matches.
- `network.listen`: `allowCidrs` (IPv4 networks, masked — `127.0.0.0/8`,
  never `127.0.0.1/8`) and `allowAddresses` (exact IPv6 literals). A bind
  or listen on an address covered by neither matcher alerts; unix-socket
  records never match a network rule.
- `privilege.change`: `toEuid` (uint32), `source` (`capset` or `creds`),
  `exemptComm` (exact comm matches, capped at the kernel's 15
  characters). All present matchers must hold.
- `kernel.module`: `ops` (array of `load` / `unload`).
- `monitor.health`: `droppedDeltaMin` — fires when the drop counter grew
  by at least this much since the previous health record, which is how
  the daemon's ring-buffer saturation threshold (1,000 since last
  report) reaches the alert path.

## Known limitation (deliberate)

`exec-from-writable` matches the recorded exe path only. The spec's
"world-writable directory" and cwd cases would require a `stat()` at match
time (state can change between record and evaluation — nondeterministic)
or a cwd/mode field in the exec record (a contract change owned by the
hooks PR, #34). The shipped rule therefore covers /tmp, /var/tmp, and
/dev/shm; widening it needs a record-contract change first.
