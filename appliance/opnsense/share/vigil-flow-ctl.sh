#!/bin/sh
# vigil-flow ctl — operator control for the sensor inside the jail
# (component spec art_4ou8t1mZ, locked decision 5).
#
# POSIX sh. The jail's exec.start/exec.stop run `start`/`stop`; operators run
# validate|status|reconfigure directly (or via the configd actions, which go
# through the host wrapper's jexec bridge). Reuses the supervisor's functions
# so validation logic has exactly one implementation.
#
# Exit codes: 0 success, 1 the requested operation failed (validate rejections,
# a failed start), 2 usage errors.

# The supervisor script ships alongside this one; tests and relocatable
# installs can point VIGIL_FLOW_SUPERVISOR_SOURCE elsewhere.
CTL_SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
VIGIL_FLOW_SUPERVISOR_SOURCE=${VIGIL_FLOW_SUPERVISOR_SOURCE:-$CTL_SCRIPT_DIR/vigil-flow-supervisor.sh}

err() {
  printf '%s: %s\n' "${0##*/}" "$1" >&2
}

die() {
  err "$1"
  exit 1
}

usage() {
  cat <<EOF
usage: ${0##*/} [--config-file PATH] start|stop|status|validate|reconfigure

Operates the vigil-flow sensor inside the jail.

  start        Validate the configuration, then run the supervisor in the
               background. A failed validation writes the DEGRADED health
               record and exits 1 — the health file always tells the truth.
  stop         Stop the supervisor gracefully (final flow export attempt),
               sweep any orphaned softflowd, and leave a STOPPED record.
  status       Print the health JSON. Exits 1 only when no status file
               exists; a DEGRADED sensor still prints its (truthful) JSON.
  validate     Run the full validation gate and print the result. A
               collector that does not resolve is advisory only (spec) and
               never fails validation.
  reconfigure  Validate the current configuration and restart the sensor
               with it.

  --config-file PATH   Read the sensor configuration from PATH (default
                       /etc/vigil-flow.conf, as installed).
EOF
}

load_supervisor_functions() {
  command -v build_softflowd_args >/dev/null 2>&1 && return 0
  [ -r "$VIGIL_FLOW_SUPERVISOR_SOURCE" ] ||
    die "supervisor library not found at $VIGIL_FLOW_SUPERVISOR_SOURCE: install both daemon scripts together"
  # The source path is computed at runtime (tests override it); CI lints
  # each file independently, which covers both files.
  # shellcheck disable=SC1090,SC1091
  VIGIL_FLOW_SKIP_MAIN=1 . "$VIGIL_FLOW_SUPERVISOR_SOURCE"
}

supervisor_running() {
  # True when the supervisor pidfile points at a live process.
  [ -f "$VIGIL_FLOW_SUPERVISOR_PIDFILE" ] || return 1
  _srun_pid=$(cat "$VIGIL_FLOW_SUPERVISOR_PIDFILE" 2>/dev/null) || return 1
  case $_srun_pid in
    '' | *[!0-9]*) return 1 ;;
  esac
  kill -0 "$_srun_pid" 2>/dev/null
}

wait_for_supervisor_exit() {
  # $1 = supervisor pid. Waits (bounded) for the process to disappear after
  # a TERM; the supervisor removes its own pidfile in graceful_stop.
  _we_pid=$1
  _we_i=0
  while [ "$_we_i" -lt 100 ]; do
    kill -0 "$_we_pid" 2>/dev/null || return 0
    sleep 0.1
    _we_i=$((_we_i + 1))
  done
  return 1
}

sweep_orphan_softflowd() {
  # Removes softflowd processes and pidfiles left behind when the
  # supervisor died without a graceful stop. The per-interface pidfile
  # suffixes make the glob exact; an unmatched glob is skipped by the -f
  # test. The deliberate `|| true`s swallow only the already-dead cases.
  for _so_pidfile in "$VIGIL_FLOW_SOFTFLOWD_PIDFILE".*; do
    [ -f "$_so_pidfile" ] || continue
    _so_pid=$(cat "$_so_pidfile" 2>/dev/null) || _so_pid=''
    case $_so_pid in
      '' | *[!0-9]*) ;;
      *)
        if kill -0 "$_so_pid" 2>/dev/null; then
          kill -TERM "$_so_pid" 2>/dev/null || true
        fi
        ;;
    esac
    rm -f "$_so_pidfile" "${_so_pidfile%.pid.*}.ctl.${_so_pidfile##*.}" 2>/dev/null || true
  done
}

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

cmd_stop() {
  if supervisor_running; then
    _stop_pid=$(cat "$VIGIL_FLOW_SUPERVISOR_PIDFILE" 2>/dev/null)
    # TERM hands the supervisor its graceful path: softflowctl shutdown
    # (final export attempt), then signal escalation, then a STOPPED record.
    kill -TERM "$_stop_pid" 2>/dev/null || true
    if ! wait_for_supervisor_exit "$_stop_pid"; then
      err "supervisor pid $_stop_pid ignored SIGTERM; sending SIGKILL"
      kill -KILL "$_stop_pid" 2>/dev/null || true
      rm -f "$VIGIL_FLOW_SUPERVISOR_PIDFILE" 2>/dev/null || true
    fi
  fi
  sweep_orphan_softflowd
  # Leave one final truthful record even on the orphan path, where no
  # supervisor existed to write it. The state machine's variables belong
  # to the supervisor — the helper, not raw assignment, writes them.
  load_config >/dev/null 2>&1 || true
  mark_stopped_and_write_health
  printf 'vigil-flow: stopped\n'
  return 0
}

cmd_status() {
  # Status must work even when the configuration is broken — fall back to
  # the default status file location, which is what the spec's dashboard
  # readers poll.
  load_config >/dev/null 2>&1 || true
  if [ -r "$STATUS_FILE" ]; then
    cat "$STATUS_FILE"
    return 0
  fi
  err "no status file at $STATUS_FILE: the sensor has never started"
  return 1
}

cmd_validate() {
  if ! run_validation_gate; then
    err "$VALIDATE_ERROR"
    return 1
  fi
  printf 'vigil-flow: configuration valid\n'
  printf '  capture_interfaces = %s\n' "$CFG_CAPTURE_INTERFACES"
  printf '  collector          = %s:%s\n' "$CFG_COLLECTOR_HOST" "$CFG_COLLECTOR_PORT"
  printf '  export_version     = %s\n' "$CFG_NF_VERSION"
  printf '  status_file        = %s\n' "$CFG_STATUS_FILE"
  # Advisory only (spec): an unresolvable or firewalled collector must
  # never block capture from starting — export problems surface in the
  # statistics polling and a stale last_stats_poll.
  collector_is_resolvable ||
    err "note: collector host '$CFG_COLLECTOR_HOST' does not resolve right now (advisory only; export failures surface in statistics)"
  return 0
}

cmd_reconfigure() {
  # Re-apply the configuration: validate first, then restart the sensor so
  # the new values are live. A failing validation leaves a running sensor
  # untouched (it keeps exporting with the last known-good config).
  if ! run_validation_gate; then
    err "$VALIDATE_ERROR"
    exit 1
  fi
  if supervisor_running; then
    _re_pid=$(cat "$VIGIL_FLOW_SUPERVISOR_PIDFILE" 2>/dev/null)
    kill -TERM "$_re_pid" 2>/dev/null || true
    wait_for_supervisor_exit "$_re_pid" ||
      rm -f "$VIGIL_FLOW_SUPERVISOR_PIDFILE" 2>/dev/null || true
  fi
  cmd_start
}

main() {
  set -eu
  _m_cmd=''
  while [ "$#" -gt 0 ]; do
    case $1 in
      --config-file)
        [ "$#" -ge 2 ] || die "--config-file requires a value"
        VIGIL_FLOW_CONFIG=$2
        shift 2
        ;;
      --help | -h)
        usage
        exit 0
        ;;
      start | stop | status | validate | reconfigure)
        [ -z "$_m_cmd" ] || die "exactly one command is allowed (got '$_m_cmd' and '$1')"
        _m_cmd=$1
        shift
        ;;
      *)
        die "unknown option or command: $1 (run with --help)"
        ;;
    esac
  done
  [ -n "$_m_cmd" ] || {
    usage >&2
    exit 2
  }
  load_supervisor_functions
  case $_m_cmd in
    start) cmd_start ;;
    stop) cmd_stop ;;
    status) cmd_status ;;
    validate) cmd_validate ;;
    reconfigure) cmd_reconfigure ;;
  esac
}

if [ "${VIGIL_FLOW_SKIP_MAIN:-0}" = "1" ]; then
  : # sourced for hermetic testing — define functions only
else
  main "$@"
fi
