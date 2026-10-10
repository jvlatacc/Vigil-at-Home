# `err` — install.sh

**Script:** `appliance/opnsense/install.sh`. Shared error printer used by every
failure path in the installer.

```sh
err() {
  printf '%s: %s\n' "${0##*/}" "$1" >&2
}
```

## Purpose

Print one error line, prefixed with the running script's basename, to stderr so
failures are attributable in a root shell or a configd log.

## Inputs and outputs

- Input: `$1` — the error message text.
- Output: one line on stderr, `<script basename>: <message>`.
- Return status: always 0.

## Side effects

None beyond the stderr line.

## Failure modes and exit codes

None — `err` never fails and never exits. Callers decide what happens next,
normally by calling `die`, which exits 1.

## Tests covering it

No direct bats case. It is exercised indirectly by every rejection test that
matches stderr text, for example "parse_args rejects a collector with an
out-of-range port" (`appliance/opnsense/tests/installer.bats`), whose
assertion is `[[ "$output" == *"outside 1-65535"* ]]`.

## Linked decisions

- [0004 — POSIX sh runtime, shellcheck + bats CI](../decisions/0004-posix-sh-runtime-shell-ci.md)
