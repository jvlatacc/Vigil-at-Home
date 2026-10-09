# `die` — vigil-flow-ctl.sh

**Script:** `appliance/opnsense/share/vigil-flow-ctl.sh`. prints an error and exits 1.

```sh
die() {
  err "$1"
  exit 1
}
```

## Purpose

Fatal path for usage errors and failed operations (exit codes: 0 success, 1 the requested operation failed, 2 usage errors).

## Inputs and outputs

- Input: `$1` — the message text.
- Output: the error line on stderr; exits with status 1.

## Side effects

Exits the process.

## Failure modes and exit codes

Exit status 1, always with a named cause on stderr.

## Tests covering it

Exercised by "ctl start with an invalid config fails and writes DEGRADED health" and the argument-dispatch paths of the ctl cases.

## Linked decisions

- [0004 — POSIX sh runtime, with the shellcheck + bats CI job](../decisions/0004-posix-sh-runtime-shell-ci.md) — loud, named failures
