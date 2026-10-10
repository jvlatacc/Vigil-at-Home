# `json_or_null` — vigil-flow-supervisor.sh

**Script:** `appliance/opnsense/share/vigil-flow-supervisor.sh`. renders a value as a JSON string, or null when it is empty.

```sh
json_or_null() {
  # $1 = value; prints a JSON string, or null when the value is empty.
  if [ -n "$1" ]; then
    json_string "$1"
  else
    printf 'null'
  fi
}
```

## Purpose

Health-file fields that legitimately have no value yet (collector before config loads, timestamps before the first poll) render as JSON null instead of empty strings.

## Inputs and outputs

- Input: `$1` — the value.
- Output: a quoted JSON string or the literal `null`.

## Side effects

None.

## Failure modes and exit codes

Never fails the caller.

## Tests covering it

Covered by "health output is valid JSON" and the early-state health assertions.

## Linked decisions

- [0004 — POSIX sh runtime, with the shellcheck + bats CI job](../decisions/0004-posix-sh-runtime-shell-ci.md) — JSON produced without jq or Node
