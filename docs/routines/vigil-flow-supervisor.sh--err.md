# `err` — vigil-flow-supervisor.sh

**Script:** `appliance/opnsense/share/vigil-flow-supervisor.sh`. prints a script-prefixed error line on stderr.

```sh
err() {
  printf '%s: %s\n' "${0##*/}" "$1" >&2
}
```

## Purpose

Shared error-line helper: every diagnostic the supervisor prints goes through here so operators can grep logs for the script name.

## Inputs and outputs

- Input: `$1` — the message text.
- Output: `<script>: <message>` on stderr.

## Side effects

None beyond the stderr line.

## Failure modes and exit codes

Never fails the caller.

## Tests covering it

No direct bats case; the statemachine suite observes its output indirectly when a refusal path runs.

## Linked decisions

- [0004 — POSIX sh runtime, with the shellcheck + bats CI job](../decisions/0004-posix-sh-runtime-shell-ci.md) — diagnostics are plain POSIX sh with no dependencies
