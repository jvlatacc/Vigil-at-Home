# `json_string` — vigil-flow-supervisor.sh

**Script:** `appliance/opnsense/share/vigil-flow-supervisor.sh`. renders an already-validated value as a quoted JSON string.

```sh
json_string() {
  # $1 = value that is already charset-validated or sanitized (see
  # sanitize_detail) -> a quoted JSON string. Escapes the two characters
  # that could break out of a JSON string literal.
  printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"
}
```

## Purpose

Escapes the two characters that could break out of a JSON string literal (backslash and double quote) so health-file content can never forge JSON structure.

## Inputs and outputs

- Input: `$1` — a value that is charset-validated or sanitized.
- Output: the quoted JSON string on stdout.

## Side effects

None.

## Failure modes and exit codes

Never fails the caller.

## Tests covering it

Underpins "health output is valid JSON", which parses the emitted health file as JSON.

## Linked decisions

- [0004 — POSIX sh runtime, with the shellcheck + bats CI job](../decisions/0004-posix-sh-runtime-shell-ci.md) — JSON produced by sed and printf — no jq on device
