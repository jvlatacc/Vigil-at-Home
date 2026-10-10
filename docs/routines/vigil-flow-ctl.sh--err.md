# `err` — vigil-flow-ctl.sh

**Script:** `appliance/opnsense/share/vigil-flow-ctl.sh`. prints a script-prefixed error line on stderr.

```sh
err() {
  printf '%s: %s\n' "${0##*/}" "$1" >&2
}
```

## Purpose

Shared error-line helper for every ctl diagnostic.

## Inputs and outputs

- Input: `$1` — the message text.
- Output: `<script>: <message>` on stderr.

## Side effects

None beyond the stderr line.

## Failure modes and exit codes

Never fails the caller.

## Tests covering it

Observed indirectly by the ctl cases in the statemachine suite.

## Linked decisions

- [0004 — POSIX sh runtime, with the shellcheck + bats CI job](../decisions/0004-posix-sh-runtime-shell-ci.md) — plain POSIX sh diagnostics
