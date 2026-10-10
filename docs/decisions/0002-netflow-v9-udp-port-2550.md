# 0002 — NetFlow v9 over UDP, collector port 2550

- **Status:** Accepted
- **Date:** 2026-10-09
- **Source of truth:** component spec (art_4ou8t1mZ), section
  "Locked — product decisions", item 2, plus its Platform evidence row on
  OPNsense Reporting/NetFlow.

## Context

The spec's Platform evidence table records that OPNsense's native export is
`softflowd` (Reporting → NetFlow): chosen interfaces, collector host/port,
and "versions v5/v9/IPFIX over UDP". softflowd is therefore the proven
exporter for this platform, and the sensor reuses it rather than writing a
flow engine.

The scaffold implements the export surface end to end:

- `install.sh` — `DEFAULT_COLLECTOR_PORT=2550`; `split_collector` parses
  `HOST[:PORT]` with a bare host taking the default; `validate_netflow_version`
  accepts only `9` or `ipfix`;
- `write_sensor_config` — emits `collector_host`, `collector_port`,
  `netflow_version` with the comment `9 | ipfix (maps to softflowd -v 9 |
-v 10)`;
- the spec's supervisor sketch maps `netflow_version` to the softflowd flag
  `9 → -v 9`, `ipfix → -v 10` ("Final flag mapping is verified against
  `softflowd(8)` at implementation time");
- `appliance/opnsense/tests/installer.bats` asserts the default port
  (`192.0.2.10` → `COLLECTOR_PORT=2550`), explicit ports, and the rejections
  (`:70000`, `:0`, empty host, `--version 5`).

## Decision

The spec's locked item 2, quoted in full:

> "**Export is NetFlow v9 over UDP** to a configurable collector address,
> default port **2550**. The config accepts `ipfix` as a later value; nothing
> else is exported in v1."

## Consequences

- The collector is off-device and must speak NetFlow v9 over UDP; the config
  surface already carries `ipfix` (softflowd `-v 10`) if a collector wants
  it.
- A bare `--collector HOST` yields port 2550; `is_valid_port` bounds the port
  to 1-65535, and IPv6 literal collectors are rejected in v1
  (`split_collector`: "IPv6 literals are not supported in v1" — the config
  surface carries exactly one host and one port).
- The spec's VALIDATE list treats collector reachability as a stats-poll
  concern, not a startup blocker: "a firewalled collector must not prevent
  capture from starting."
- Flow behavior knobs ship at the spec's fixed values
  (`active_timeout = 300`, `inactive_timeout = 30`, `max_flows = 8192` in
  `write_sensor_config`).

## Alternatives considered

- **NetFlow v5.** Part of softflowd's supported set per the spec's OPNsense
  evidence, but not carried by the config surface: the spec says "nothing
  else is exported in v1".
- **IPFIX-only.** Deferred rather than rejected — the config accepts `ipfix`
  from day one; the default is v9.
- **A non-UDP transport.** Out of scope for v1; the spec's open-questions
  section notes that "if the collector turns out to expect IPFIX or a
  non-UDP transport, the config surface already carries the change."
- **A custom flow engine.** Rejected: softflowd is the proven exporter on
  this platform (spec, Platform evidence); the sensor reuses it.

## Related decisions

- [0001 — Capture runs entirely inside the jail](0001-jail-contained-capture-non-vnet-bpf.md)
  (where the export originates)
- [0006 — Jail userland from base.txz](0006-jail-userland-base-txz-softflowd.md)
  (how softflowd gets into the jail)
- Config key reference: [data.md, sensor configuration keys](../design/data.md);
  routine references: [`split_collector`](../routines/install.sh--split_collector.md),
  [`validate_netflow_version`](../routines/install.sh--validate_netflow_version.md),
  [`is_valid_port`](../routines/install.sh--is_valid_port.md).
