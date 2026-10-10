# `cmd_start` — vigil-flow-ctl.sh

**Script:** `appliance/opnsense/share/vigil-flow-ctl.sh`. validates the configuration, then launches the supervisor in the background.

```sh
cmd_start() {
  if supervisor_running; then
    printf 'vigil-flow: already running (supervisor pid %s)\n' \
      "$(cat "$VIGIL_FLOW_SUPERVISOR_PIDFILE" 2>/dev/null)"
    return 0
  fi
  # VALIDATE runs before the first spawn (spec state machine). On failure,
  # write the DEGRADED record first — the health file must tell the truth
  # from the very first boot, even when no supervisor ever runs.
  if ! run_validation_gate; then
    degrade "$VALIDATE_ERROR"
    err "$VALIDATE_ERROR"
    exit 1
  fi
  # The supervisor is a separate process: export every overridable location
  # it needs to re-derive the same sandbox this invocation validated.
  export VIGIL_FLOW_CONFIG VIGIL_FLOW_STATUS_FILE VIGIL_FLOW_SUPERVISOR_PIDFILE \
    VIGIL_FLOW_SOFTFLOWD_PIDFILE VIGIL_FLOW_SOFTFLOWD_CTLFILE VIGIL_FLOW_SOFTFLOWD \
    VIGIL_FLOW_SOFTFLOWCTL VIGIL_FLOW_IFCONFIG VIGIL_FLOW_BPF_DIR \
    VIGIL_FLOW_POLL_INTERVAL VIGIL_FLOW_MAX_CONSEC_RESTARTS VIGIL_FLOW_MAX_BACKOFF
  # Detached launch: stdio off the terminal, backgrounded. A non-interactive
  # shell does not SIGHUP background jobs on exit, so the supervisor
  # survives this script returning (the jail stays up via `persist`).
  "$VIGIL_FLOW_SUPERVISOR_SOURCE" run </dev/null >/dev/null 2>&1 3<&- 4<&- 5<&- 6<&- 7<&- 8<&- 9<&- &
  _cs_pid=$!
  _cs_i=0
  while [ "$_cs_i" -lt 50 ]; do
    # Started means THIS launch owns the pidfile — a pid naming some other
    # process is a stale or foreign supervisor, not a success.
    if [ -f "$VIGIL_FLOW_SUPERVISOR_PIDFILE" ] &&
      [ "$(cat "$VIGIL_FLOW_SUPERVISOR_PIDFILE" 2>/dev/null)" = "$_cs_pid" ]; then
      printf 'vigil-flow: started (supervisor pid %s)\n' "$_cs_pid"
      return 0
    fi
    # Exit early if the supervisor process itself already died.
    kill -0 "$_cs_pid" 2>/dev/null || break
    sleep 0.1
    _cs_i=$((_cs_i + 1))
  done
  err "supervisor did not come up; see $(dirname "$STATUS_FILE")/status.json or run validate"
  exit 1
}
```

## Purpose

The `start` command. Idempotent: a running supervisor is reported and left alone. The validation gate runs before the first spawn; on failure the DEGRADED health record is written first — the health file tells the truth from the very first boot, even when no supervisor ever runs — and the command exits 1. On success the overridable locations are exported for the child process and the supervisor is launched detached (stdio off the terminal, file descriptors 3-9 closed), then waited on for up to 5 seconds until the pidfile names this launch's pid — a pid naming some other process is a stale or foreign supervisor, not a success.

## Inputs and outputs

- Input: `$VIGIL_FLOW_CONFIG` (or `--config-file PATH`), the overridable locations.
- Output: a `started (supervisor pid N)` or `already running` line on stdout.
- Return status: 0 started/already running; 1 when validation fails or the supervisor does not come up.

## Side effects

Writes the DEGRADED health record on a failed gate; starts the supervisor process (which writes its own pidfile and health record).

## Failure modes and exit codes

Exit 1 with the named validation cause, or with a pointer to the status directory when the supervisor fails to come up.

## Tests covering it

"ctl start reaches RUNNING and the stub records the exact spec argv" (boot to RUNNING with the exact argv recorded), "ctl start with an invalid config fails and writes DEGRADED health" (invalid config writes DEGRADED health and fails), "ctl start is idempotent while the sensor is running" (idempotent).

## Linked decisions

- [0005 — No PHP GUI in v1: configd actions plus the ctl surface](../decisions/0005-no-php-gui-configd-actions.md) — the primary operator command
- [0001 — Capture runs entirely inside the jail](../decisions/0001-jail-contained-capture-non-vnet-bpf.md) — the health file tells the truth from first boot
