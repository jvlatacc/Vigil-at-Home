# `ctlfile_for` — vigil-flow-supervisor.sh

**Script:** `appliance/opnsense/share/vigil-flow-supervisor.sh`. computes the per-interface softflowctl control-socket path.

```sh
ctlfile_for() {
  # $1 = interface; per-child softflowd control socket.
  printf '%s.%s' "$VIGIL_FLOW_SOFTFLOWD_CTLFILE" "$1"
}
```

## Purpose

The control-socket twin of `pidfile_for`: per-interface suffixes keep `softflowctl` commands pointed at the right child.

## Inputs and outputs

- Input: `$1` — interface name.
- Output: the path on stdout.

## Side effects

None.

## Failure modes and exit codes

Cannot fail.

## Tests covering it

Exercised through the statemachine suite's stats and stop cases.

## Linked decisions

- [0004 — POSIX sh runtime, with the shellcheck + bats CI job](../decisions/0004-posix-sh-runtime-shell-ci.md) — one softflowd child per interface, no shared state
