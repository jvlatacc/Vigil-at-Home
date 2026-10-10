# `die` — vigil-flow-supervisor.sh

**Script:** `appliance/opnsense/share/vigil-flow-supervisor.sh`. prints an error and exits 1 — the supervisor's only fatal path.

```sh
die() {
  err "$1"
  exit 1
}
```

## Purpose

Combines `err` with `exit 1` for the cases where continuing is wrong: usage errors and the single-instance backstop.

## Inputs and outputs

- Input: `$1` — the message text.
- Output: the error line on stderr; terminates the process with status 1.

## Side effects

Exits the process.

## Failure modes and exit codes

Exit status 1, always with a named cause on stderr.

## Tests covering it

Exercised by every statemachine refusal path (e.g. "a vanished softflowd binary degrades with softflowd_missing"), which assert the non-zero outcome and message.

## Linked decisions

- [0004 — POSIX sh runtime, with the shellcheck + bats CI job](../decisions/0004-posix-sh-runtime-shell-ci.md) — failures are loud and named, never silent
