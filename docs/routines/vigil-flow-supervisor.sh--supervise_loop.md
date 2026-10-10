# `supervise_loop` — vigil-flow-supervisor.sh

**Script:** `appliance/opnsense/share/vigil-flow-supervisor.sh`. the supervisor's tick loop.

```sh
supervise_loop() {
  while :; do
    sleep "$VIGIL_FLOW_POLL_INTERVAL"
    supervise_once
  done
}
```

## Purpose

Sleeps `$VIGIL_FLOW_POLL_INTERVAL` (30s) between `supervise_once` ticks, forever — the loop is only left via signals.

## Inputs and outputs

- Effects: runs supervision ticks indefinitely.

## Side effects

Everything the ticks do.

## Failure modes and exit codes

Never returns on its own.

## Tests covering it

Exercised implicitly: the statemachine suite drives ticks and then stops the supervisor through the ctl.

## Linked decisions

- [0004 — POSIX sh runtime, with the shellcheck + bats CI job](../decisions/0004-posix-sh-runtime-shell-ci.md) — a plain while loop; the interval is overridable for tests
