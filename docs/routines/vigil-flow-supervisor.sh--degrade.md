# `degrade` — vigil-flow-supervisor.sh

**Script:** `appliance/opnsense/share/vigil-flow-supervisor.sh`. enters DEGRADED with a named cause.

```sh
degrade() {
  # $1 = named cause. DEGRADED always carries a named cause; the supervisor
  # keeps running and re-checks for recovery on every tick.
  DEGRADED_CAUSE=$1
  set_state DEGRADED
}
```

## Purpose

DEGRADED always carries a named cause — config missing or invalid, the bpf grant lost, an interface gone, a binary missing, restarts exhausted. The supervisor keeps running and re-checks for recovery on every tick, so a fixed cause recovers without an operator restart.

## Inputs and outputs

- Input: `$1` — the cause string (sanitized before the health file renders it).
- Effects: sets `DEGRADED_CAUSE`; `set_state DEGRADED`.

## Side effects

Rewrites the health file through `set_state`.

## Failure modes and exit codes

Propagates `write_health`'s fatal case.

## Tests covering it

The statemachine degrade cases: "restart bound exhaustion degrades with a named cause", "losing the bpf grant degrades with bpf_missing and recovery is automatic", "a vanished softflowd binary degrades with softflowd_missing", "ctl start with an invalid config fails and writes DEGRADED health".

## Linked decisions

- [0001 — Capture runs entirely inside the jail](../decisions/0001-jail-contained-capture-non-vnet-bpf.md) — a crash never leaves the jail silently dark — the health file says why
