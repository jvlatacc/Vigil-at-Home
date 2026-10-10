# `mark_stopped_and_write_health` — vigil-flow-supervisor.sh

**Script:** `appliance/opnsense/share/vigil-flow-supervisor.sh`. writes the canonical STOPPED health record.

```sh
mark_stopped_and_write_health() {
  # Final truthful record after a stop: no children left, no cause. The ctl
  # reuses this on the orphan path so stop-state writes stay in one place.
  CHILDREN=''
  STATE=STOPPED
  DEGRADED_CAUSE=''
  write_health
}
```

## Purpose

Clears the registry and cause, sets `STATE=STOPPED`, and rewrites the health file. The ctl's stop path reuses this on the orphan path — where no supervisor existed to write its own record — so stop-state writes stay in one place.

## Inputs and outputs

- Effects: rewrites the health file with `state=STOPPED`, no cause, no children.

## Side effects

Writes the health file.

## Failure modes and exit codes

Propagates `write_health`'s fatal case.

## Tests covering it

"ctl stop leaves STOPPED, no supervisor, and no children" asserts the record's shape.

## Linked decisions

- [0004 — POSIX sh runtime, with the shellcheck + bats CI job](../decisions/0004-posix-sh-runtime-shell-ci.md) — one implementation of the stopped record, shared
