# `pidfile_for` — vigil-flow-supervisor.sh

**Script:** `appliance/opnsense/share/vigil-flow-supervisor.sh`. computes the per-interface softflowd pidfile path.

```sh
pidfile_for() {
  # $1 = interface; per-child pidfile (suffixed per interface so multiple
  # capture interfaces never clobber each other).
  printf '%s.%s' "$VIGIL_FLOW_SOFTFLOWD_PIDFILE" "$1"
}
```

## Purpose

Suffixed with the interface name (e.g. `/var/run/vigil-flow-softflowd.pid.lan0`) so multiple capture interfaces never clobber each other's pidfiles or control sockets.

## Inputs and outputs

- Input: `$1` — interface name.
- Output: the path on stdout.

## Side effects

None.

## Failure modes and exit codes

Cannot fail.

## Tests covering it

Exercised through the statemachine suite's multi-interface and orphan-sweep assertions.

## Linked decisions

- [0004 — POSIX sh runtime, with the shellcheck + bats CI job](../decisions/0004-posix-sh-runtime-shell-ci.md) — one softflowd child per interface, no shared state
