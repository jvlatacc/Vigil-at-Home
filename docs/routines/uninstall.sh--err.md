# `err` — uninstall.sh

**Script:** `appliance/opnsense/uninstall.sh`. Shared error printer.

```sh
err() {
  printf '%s: %s\n' "${0##*/}" "$1" >&2
}
```

## Purpose

Print one error line, prefixed with the running script's basename, to stderr.
Mirrors the installer's `err` of the same name — each script stands alone, so
the definition is duplicated rather than shared.

## Inputs and outputs

- Input: `$1` — the error message text.
- Output: one line on stderr, `<script basename>: <message>`.
- Return status: always 0.

## Side effects

None beyond the stderr line.

## Failure modes and exit codes

None — never fails, never exits; callers decide (normally via `die`).

## Tests covering it

No direct bats case. Its users in this script (`main`'s guards,
`process_manifest`'s unknown-line report) are on-device verified; the bats
suite runs with `VIGIL_FLOW_SKIP_MAIN=1` and does not call it.

## Linked decisions

- [0004 — POSIX sh runtime, shellcheck + bats CI](../decisions/0004-posix-sh-runtime-shell-ci.md)
