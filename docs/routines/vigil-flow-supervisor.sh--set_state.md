# `set_state` — vigil-flow-supervisor.sh

**Script:** `appliance/opnsense/share/vigil-flow-supervisor.sh`. records a state transition and rewrites the health file.

```sh
set_state() {
  # $1 = new state. Records the transition and rewrites the health file —
  # every transition rewrites the JSON (the supervisor's one contract).
  STATE=$1
  LAST_TRANSITION=$(now_utc)
  write_health
}
```

## Purpose

Every transition — and therefore every call here — rewrites the health JSON (`write_health`) and stamps `last_transition`. This is the supervisor's one contract made mechanical: the health file cannot drift from the state.

## Inputs and outputs

- Input: `$1` — the new state (`BOOTING`, `VALIDATE`, `RUNNING`, `RESTARTING`, `DEGRADED`, `STOPPED`).
- Effects: sets `STATE` and `LAST_TRANSITION`; rewrites the health file.

## Side effects

Writes the health file (atomically).

## Failure modes and exit codes

Propagates `write_health`'s fatal case (unwritable status directory).

## Tests covering it

Underlies every statemachine case; "health output is valid JSON" asserts the JSON stays valid across transitions.

## Linked decisions

- [0004 — POSIX sh runtime, with the shellcheck + bats CI job](../decisions/0004-posix-sh-runtime-shell-ci.md) — the contract is implemented in plain sh, atomically
