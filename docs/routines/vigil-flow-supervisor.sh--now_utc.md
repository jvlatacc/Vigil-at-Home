# `now_utc` — vigil-flow-supervisor.sh

**Script:** `appliance/opnsense/share/vigil-flow-supervisor.sh`. prints the current UTC time as ISO 8601 with a Z suffix.

```sh
now_utc() {
  # ISO 8601 UTC timestamp for the health file.
  date -u +%Y-%m-%dT%H:%M:%SZ
}
```

## Purpose

Timestamp source for the health file's `last_transition` and `last_stats_poll` fields.

## Inputs and outputs

- Output: `YYYY-MM-DDTHH:MM:SSZ` from `date -u`.

## Side effects

None.

## Failure modes and exit codes

Cannot fail.

## Tests covering it

Indirectly covered: the statemachine suite asserts the timestamp fields are present in the health JSON ("health output is valid JSON").

## Linked decisions

- [0004 — POSIX sh runtime, with the shellcheck + bats CI job](../decisions/0004-posix-sh-runtime-shell-ci.md) — uses only the FreeBSD base system's `date`
