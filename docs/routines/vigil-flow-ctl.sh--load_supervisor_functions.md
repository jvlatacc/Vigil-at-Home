# `load_supervisor_functions` — vigil-flow-ctl.sh

**Script:** `appliance/opnsense/share/vigil-flow-ctl.sh`. sources the supervisor's functions so validation exists exactly once.

```sh
load_supervisor_functions() {
  command -v build_softflowd_args >/dev/null 2>&1 && return 0
  [ -r "$VIGIL_FLOW_SUPERVISOR_SOURCE" ] ||
    die "supervisor library not found at $VIGIL_FLOW_SUPERVISOR_SOURCE: install both daemon scripts together"
  # The source path is computed at runtime (tests override it); CI lints
  # each file independently, which covers both files.
  # shellcheck disable=SC1090,SC1091
  VIGIL_FLOW_SKIP_MAIN=1 . "$VIGIL_FLOW_SUPERVISOR_SOURCE"
}
```

## Purpose

No-op when the supervisor functions are already defined (a sourced supervisor); otherwise requires a readable `$VIGIL_FLOW_SUPERVISOR_SOURCE` (the supervisor script ships alongside the ctl) and sources it with `$VIGIL_FLOW_SKIP_MAIN=1`, so only the definitions load. The ctl reuses the supervisor's validation gate rather than keeping a second implementation that could drift.

## Inputs and outputs

- Input: `$VIGIL_FLOW_SUPERVISOR_SOURCE` (default: the supervisor next to this script).

## Side effects

Loads function definitions into the shell.

## Failure modes and exit codes

`die`s (exit 1) when the supervisor source is missing or unreadable — both daemon scripts must be installed together.

## Tests covering it

Implicit in every ctl bats case (the suite points `$VIGIL_FLOW_SUPERVISOR_SOURCE` at the repo script).

## Linked decisions

- [0004 — POSIX sh runtime, with the shellcheck + bats CI job](../decisions/0004-posix-sh-runtime-shell-ci.md) — one validation implementation, sourced not copied
