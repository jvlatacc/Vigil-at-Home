# `restart_backoff_seconds` — vigil-flow-supervisor.sh

**Script:** `appliance/opnsense/share/vigil-flow-supervisor.sh`. computes the exponential restart backoff, capped.

```sh
restart_backoff_seconds() {
  # $1 = attempt number (1-based). Exponential backoff, capped — the spec's
  # "backoff, bounded retries": the cap keeps a crash loop from sleeping
  # forever, the attempt bound below stops it from retrying forever.
  _rb=$(( 1 << ($1 - 1) ))
  [ "$_rb" -gt "$VIGIL_FLOW_MAX_BACKOFF" ] && _rb=$VIGIL_FLOW_MAX_BACKOFF
  printf '%s\n' "$_rb"
}
```

## Purpose

Attempt 1 sleeps 1s, attempt 2 sleeps 2s, and so on — doubling up to `$VIGIL_FLOW_MAX_BACKOFF` (60s). The cap keeps a crash loop from sleeping forever; the attempt bound in `supervise_children` keeps it from retrying forever.

## Inputs and outputs

- Input: `$1` — 1-based attempt number.
- Output: the seconds to sleep on stdout.

## Side effects

None.

## Failure modes and exit codes

Cannot fail.

## Tests covering it

Exercised through "a dead child is restarted, counted, and health returns to RUNNING" and "restart bound exhaustion degrades with a named cause" (the stub verifies the delays stay bounded).

## Linked decisions

- [0004 — POSIX sh runtime, with the shellcheck + bats CI job](../decisions/0004-posix-sh-runtime-shell-ci.md) — backoff arithmetic in POSIX arithmetic, no helpers
