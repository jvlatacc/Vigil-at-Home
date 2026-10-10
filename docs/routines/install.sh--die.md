# `die` — install.sh

**Script:** `appliance/opnsense/install.sh`. Loud failure primitive: print a
named cause, then exit non-zero.

```sh
die() {
  err "$1"
  exit 1
}
```

## Purpose

Turn any guard failure into a stopped install with a human-readable cause, per
the installer header's contract: "Every failure prints a named cause and exits
non-zero."

## Inputs and outputs

- Input: `$1` — the cause, phrased as a sentence (for example
  `"this installer must run as root"`).
- Output: the cause on stderr via `err`.
- Return status: does not return — exits the process with status 1.

## Side effects

Terminates the installer. Under `set -eu` in `main`, no further host
modification happens after a `die`.

## Failure modes and exit codes

`die` is the failure path. Exit code 1, cause named on stderr.

## Tests covering it

Not asserted directly: the bats suite sources the installer with
`VIGIL_FLOW_SKIP_MAIN=1` (functions only, no `main`), and the rejections it
asserts go through `parse_args` and the validators, which return 1 without
exiting so `run` can capture them. The `die`-based guards (root check,
`opnsense-version` check, ABI detection, fetch and pkg failures) are verified
on device per the [verification boundary](../design/data.md).

## Linked decisions

- [0004 — POSIX sh runtime, shellcheck + bats CI](../decisions/0004-posix-sh-runtime-shell-ci.md)
- [0006 — Jail userland from base.txz, zero host packages](../decisions/0006-jail-userland-base-txz-softflowd.md)
  (loud, named installer failures)
