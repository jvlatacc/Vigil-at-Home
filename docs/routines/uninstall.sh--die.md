# `die` — uninstall.sh

**Script:** `appliance/opnsense/uninstall.sh`. Loud failure primitive: print a
named cause, then exit 1.

```sh
die() {
  err "$1"
  exit 1
}
```

## Purpose

Stop the uninstall with a human-readable cause when a precondition fails
(not root, empty `VIGIL_ROOT`, no manifest). Mirrors the installer's `die`.

## Inputs and outputs

- Input: `$1` — the cause.
- Output: the cause on stderr via `err`.
- Return status: does not return — exits with status 1.

## Side effects

Terminates the uninstaller before any removal happens when raised from the
`main` guards (all `die` calls in this script precede the destructive steps).

## Failure modes and exit codes

`die` is the failure path. Exit code 1, cause named on stderr.

## Tests covering it

Not asserted directly; the guards that use it run only in `main`, which the
bats suite skips via `VIGIL_FLOW_SKIP_MAIN=1`. Verified on device: running the
uninstaller without a manifest exits 1 with
`no install manifest at … (was install.sh run?)`.

## Linked decisions

- [0004 — POSIX sh runtime, shellcheck + bats CI](../decisions/0004-posix-sh-runtime-shell-ci.md)
