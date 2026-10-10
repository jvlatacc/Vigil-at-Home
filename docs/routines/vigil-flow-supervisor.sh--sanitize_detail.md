# `sanitize_detail` — vigil-flow-supervisor.sh

**Script:** `appliance/opnsense/share/vigil-flow-supervisor.sh`. strips JSON-structure and shell metacharacters from unvalidated text.

```sh
sanitize_detail() {
  # $1 = unvalidated text bound for a health-file cause string. Strips the
  # characters that could forge JSON structure or shell expansion, and
  # truncates. Used wherever a cause embeds a value that has not been
  # through the config validator's charsets.
  printf '%s' "$1" | tr -d '"\\`$' | cut -c 1-80
}
```

## Purpose

Any health-file cause string that embeds a value which did not pass the config validator's charsets goes through here first: quotes, backticks and dollar signs are removed and the result truncated to 80 characters, so a hostile config value cannot forge JSON structure or shell expansion in the health file.

## Inputs and outputs

- Input: `$1` — unvalidated text bound for a `degraded_cause` string.
- Output: the sanitized, truncated text on stdout.

## Side effects

None.

## Failure modes and exit codes

Never fails the caller.

## Tests covering it

Exercised by the statemachine suite's degrade cases, which parse the health JSON after a cause is written.

## Linked decisions

- [0004 — POSIX sh runtime, with the shellcheck + bats CI job](../decisions/0004-posix-sh-runtime-shell-ci.md) — defense in depth in pure POSIX sh
