#!/bin/sh
# vigil-flow supervisor — the in-jail daemon that keeps softflowd exporting
# NetFlow to the off-device collector (component spec art_4ou8t1mZ).
#
# POSIX sh; no Node.js on device. One softflowd child per configured capture
# interface, each with its own pidfile and control socket. The supervisor
# implements the spec's state machine
#
#   BOOT -> VALIDATE -> RUNNING -> RESTARTING -> (DEGRADED <-> recovery)
#
# with one contract: the health file always tells the truth, and a crash
# never leaves the jail silently dark. Every transition and every successful
# stats poll rewrites the health JSON atomically (write to a temp file, then
# rename), so a reader never observes a half-written file.
#
# Collector unreachability NEVER blocks startup (spec): DNS/route problems
# surface through statistics polling, not as a VALIDATE failure.
#
# Testing contract: when VIGIL_FLOW_SKIP_MAIN is set, sourcing this file only
# defines functions. The bats suite (appliance/opnsense/tests) exercises the
# pure functions and drives ticks hermetically through the overridable
# locations below; no test touches a network or a real softflowd.

# Overridable locations and binaries (tests and ctl repoint these at a
# temporary sandbox, mirroring the installer's overridable-locations pattern).
VIGIL_FLOW_CONFIG=${VIGIL_FLOW_CONFIG:-/etc/vigil-flow.conf}
VIGIL_FLOW_STATUS_FILE=${VIGIL_FLOW_STATUS_FILE:-/var/db/vigil-flow/status.json}
VIGIL_FLOW_SUPERVISOR_PIDFILE=${VIGIL_FLOW_SUPERVISOR_PIDFILE:-/var/run/vigil-flow-supervisor.pid}
VIGIL_FLOW_SOFTFLOWD_PIDFILE=${VIGIL_FLOW_SOFTFLOWD_PIDFILE:-/var/run/vigil-flow-softflowd.pid}
VIGIL_FLOW_SOFTFLOWD_CTLFILE=${VIGIL_FLOW_SOFTFLOWD_CTLFILE:-/var/run/vigil-flow-softflowd.ctl}
VIGIL_FLOW_SOFTFLOWD=${VIGIL_FLOW_SOFTFLOWD:-/usr/local/sbin/softflowd}
VIGIL_FLOW_SOFTFLOWCTL=${VIGIL_FLOW_SOFTFLOWCTL:-/usr/local/bin/softflowctl}
VIGIL_FLOW_IFCONFIG=${VIGIL_FLOW_IFCONFIG:-/sbin/ifconfig}
VIGIL_FLOW_BPF_DIR=${VIGIL_FLOW_BPF_DIR:-/dev}
VIGIL_FLOW_POLL_INTERVAL=${VIGIL_FLOW_POLL_INTERVAL:-30}
VIGIL_FLOW_MAX_CONSEC_RESTARTS=${VIGIL_FLOW_MAX_CONSEC_RESTARTS:-5}
VIGIL_FLOW_MAX_BACKOFF=${VIGIL_FLOW_MAX_BACKOFF:-60}

# State-machine and supervision state (mutated by run/supervise; functions
# are pure with respect to their arguments and read/write these explicitly).
STATE=BOOTING
DEGRADED_CAUSE=''
VALIDATE_ERROR=''
STATUS_FILE=$VIGIL_FLOW_STATUS_FILE
CONSECUTIVE_RESTART_FAILURES=0
LAST_STATS_POLL=''
LAST_TRANSITION=''
FLOWS_TOTAL=0
# Child registry: one "iface|pid|attempts|flows" line per capture interface.
CHILDREN=''
# Parsed configuration (empty until a config file loads; initialized so the
# health writer can run before any config exists, e.g. at BOOTING).
CFG_CAPTURE_INTERFACES=''
CFG_COLLECTOR_HOST=''
CFG_COLLECTOR_PORT=''
CFG_NF_VERSION=''
CFG_ACTIVE_TIMEOUT=''
CFG_INACTIVE_TIMEOUT=''
CFG_MAX_FLOWS=''
CFG_STATUS_FILE=''

err() {
  printf '%s: %s\n' "${0##*/}" "$1" >&2
}

die() {
  err "$1"
  exit 1
}

usage() {
  cat <<EOF
usage: ${0##*/} [--config-file PATH] run

Runs the vigil-flow sensor supervisor until terminated. Started by
vigil-flow-ctl.sh start (the jail's exec.start); not normally invoked by
hand. Terminated gracefully with SIGTERM, which stops the softflowd
children after a final flow export attempt.
EOF
}

now_utc() {
  # ISO 8601 UTC timestamp for the health file.
  date -u +%Y-%m-%dT%H:%M:%SZ
}

trim_ws() {
  # $1 = string; prints it without leading/trailing spaces and tabs.
  _tw_v=$1
  while :; do
    case $_tw_v in
      ' '* | '	'*) _tw_v=${_tw_v#?} ;;
      *) break ;;
    esac
  done
  while :; do
    case $_tw_v in
      *' ' | *'	') _tw_v=${_tw_v%?} ;;
      *) break ;;
    esac
  done
  printf '%s' "$_tw_v"
}

json_string() {
  # $1 = value that is already charset-validated or sanitized (see
  # sanitize_detail) -> a quoted JSON string. Escapes the two characters
  # that could break out of a JSON string literal.
  printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"
}

json_or_null() {
  # $1 = value; prints a JSON string, or null when the value is empty.
  if [ -n "$1" ]; then
    json_string "$1"
  else
    printf 'null'
  fi
}

json_iface_array() {
  # $1 = comma-separated interface list -> a JSON array of strings.
  _ja_out=''
  _ja_list=$1
  while [ -n "$_ja_list" ]; do
    _ja_tok=${_ja_list%%,*}
    _ja_sep=''
    [ -n "$_ja_out" ] && _ja_sep=', '
    _ja_out="$_ja_out$_ja_sep$(json_string "$_ja_tok")"
    [ "$_ja_tok" = "$_ja_list" ] && break
    _ja_list=${_ja_list#*,}
  done
  printf '[%s]' "$_ja_out"
}

sanitize_detail() {
  # $1 = unvalidated text bound for a health-file cause string. Strips the
  # characters that could forge JSON structure or shell expansion, and
  # truncates. Used wherever a cause embeds a value that has not been
  # through the config validator's charsets.
  printf '%s' "$1" | tr -d '"\\`$' | cut -c 1-80
}

is_valid_port() {
  # $1 = candidate port. Numeric and within 1-65535.
  case $1 in
    '' | *[!0-9]*) return 1 ;;
  esac
  [ "$1" -ge 1 ] && [ "$1" -le 65535 ]
}

is_int_in_range() {
  # $1 = value, $2 = min, $3 = max. Numeric and within the range.
  case $1 in
    '' | *[!0-9]*) return 1 ;;
  esac
  [ "$1" -ge "$2" ] && [ "$1" -le "$3" ]
}

is_iface_list() {
  # $1 = comma-separated capture interface list; syntax only (existence on
  # the host stack is a runtime check). Mirrors the installer's rules: no
  # empty tokens, names limited to [A-Za-z0-9._-].
  case $1 in
    '' | ,* | *, | *,,*) return 1 ;;
  esac
  _il_list=$1
  while [ -n "$_il_list" ]; do
    _il_tok=${_il_list%%,*}
    case $_il_tok in
      '' | *[!A-Za-z0-9._-]*) return 1 ;;
    esac
    [ "$_il_tok" = "$_il_list" ] && break
    _il_list=${_il_list#*,}
  done
}

load_config() {
  # Parses the POSIX key = "value" sensor configuration into CFG_* variables.
  # Never evals: the grammar is strict (bare identifier keys, single quoted
  # value), and every value must pass a per-key charset before it is kept,
  # so a hostile config file cannot inject code or forge JSON structure.
  # On failure returns 1 with a named cause in VALIDATE_ERROR.
  VALIDATE_ERROR=''
  [ -f "$VIGIL_FLOW_CONFIG" ] || {
    VALIDATE_ERROR="config_missing: no configuration file at $VIGIL_FLOW_CONFIG"
    return 1
  }
  [ -r "$VIGIL_FLOW_CONFIG" ] || {
    VALIDATE_ERROR="config_unreadable: $VIGIL_FLOW_CONFIG is not readable by this user"
    return 1
  }

  CFG_CAPTURE_INTERFACES=''
  CFG_COLLECTOR_HOST=''
  CFG_COLLECTOR_PORT=''
  CFG_NF_VERSION=''
  CFG_ACTIVE_TIMEOUT=''
  CFG_INACTIVE_TIMEOUT=''
  CFG_MAX_FLOWS=''
  CFG_STATUS_FILE=''
  _lc_seen=' '
  _lc_lineno=0
  while IFS= read -r _lc_line || [ -n "$_lc_line" ]; do
    _lc_lineno=$((_lc_lineno + 1))
    case $_lc_line in
      '' | \#*) continue ;;
    esac
    case $_lc_line in
      *=*) ;;
      *)
        VALIDATE_ERROR="config_invalid: line $_lc_lineno has no '=' separator"
        return 1
        ;;
    esac
    _lc_key=$(trim_ws "${_lc_line%%=*}")
    _lc_value=$(trim_ws "${_lc_line#*=}")
    case $_lc_value in
      '"'*'"') ;;
      *)
        VALIDATE_ERROR="config_invalid: line $_lc_lineno: '$_lc_key' must be a double-quoted value"
        return 1
        ;;
    esac
    _lc_value=${_lc_value#\"}
    _lc_value=${_lc_value%\"}
    case $_lc_key in
      *[!A-Za-z0-9_]*)
        VALIDATE_ERROR="config_invalid: line $_lc_lineno: key '$_lc_key' is not a bare identifier"
        return 1
        ;;
    esac
    case $_lc_seen in
      *" $_lc_key "*)
        VALIDATE_ERROR="config_invalid: line $_lc_lineno: duplicate key '$_lc_key'"
        return 1
        ;;
    esac
    _lc_seen="$_lc_seen$_lc_key "

    case $_lc_key in
      capture_interfaces)
        is_iface_list "$_lc_value" || {
          VALIDATE_ERROR="config_invalid: capture_interfaces '$_lc_value': every entry must be a non-empty name of [A-Za-z0-9._-]"
          return 1
        }
        CFG_CAPTURE_INTERFACES=$_lc_value
        ;;
      collector_host)
        case $_lc_value in
          '' | *[!A-Za-z0-9.-]*)
            VALIDATE_ERROR="config_invalid: collector_host '$_lc_value' is not a hostname or IPv4 address"
            return 1
            ;;
        esac
        CFG_COLLECTOR_HOST=$_lc_value
        ;;
      collector_port)
        is_valid_port "$_lc_value" || {
          VALIDATE_ERROR="config_invalid: collector_port '$_lc_value' is outside 1-65535"
          return 1
        }
        CFG_COLLECTOR_PORT=$_lc_value
        ;;
      netflow_version)
        case $_lc_value in
          9 | ipfix) ;;
          *)
            VALIDATE_ERROR="config_invalid: netflow_version '$_lc_value' must be 9 or ipfix"
            return 1
            ;;
        esac
        CFG_NF_VERSION=$_lc_value
        ;;
      active_timeout | inactive_timeout)
        is_int_in_range "$_lc_value" 1 604800 || {
          VALIDATE_ERROR="config_invalid: $_lc_key '$_lc_value' must be an integer of 1-604800 seconds"
          return 1
        }
        case $_lc_key in
          active_timeout) CFG_ACTIVE_TIMEOUT=$_lc_value ;;
          inactive_timeout) CFG_INACTIVE_TIMEOUT=$_lc_value ;;
        esac
        ;;
      max_flows)
        is_int_in_range "$_lc_value" 1 1048576 || {
          VALIDATE_ERROR="config_invalid: max_flows '$_lc_value' must be an integer of 1-1048576"
          return 1
        }
        CFG_MAX_FLOWS=$_lc_value
        ;;
      status_file)
        case $_lc_value in
          /*) ;;
          *)
            VALIDATE_ERROR="config_invalid: status_file '$_lc_value' must be an absolute path"
            return 1
            ;;
        esac
        case $_lc_value in
          *[!A-Za-z0-9/._-]*)
            VALIDATE_ERROR="config_invalid: status_file '$_lc_value' contains characters outside [A-Za-z0-9/._-]"
            return 1
            ;;
        esac
        CFG_STATUS_FILE=$_lc_value
        ;;
      *)
        VALIDATE_ERROR="config_invalid: line $_lc_lineno: unknown key '$_lc_key'"
        return 1
        ;;
    esac
  done < "$VIGIL_FLOW_CONFIG"

  [ -n "$CFG_STATUS_FILE" ] && STATUS_FILE=$CFG_STATUS_FILE
  return 0
}

validate_loaded_config() {
  # Cross-field checks the parser cannot express: every required key present.
  # Per-key range/charset validation already happened in load_config. The
  # case dispatch reads the CFG_ variables without eval, so even our own
  # fixed key names are never dynamically executed.
  VALIDATE_ERROR=''
  _vl_missing=''
  for _vl_key in capture_interfaces collector_host collector_port netflow_version \
    active_timeout inactive_timeout max_flows status_file; do
    case $_vl_key in
      capture_interfaces) _vl_val=$CFG_CAPTURE_INTERFACES ;;
      collector_host) _vl_val=$CFG_COLLECTOR_HOST ;;
      collector_port) _vl_val=$CFG_COLLECTOR_PORT ;;
      netflow_version) _vl_val=$CFG_NF_VERSION ;;
      active_timeout) _vl_val=$CFG_ACTIVE_TIMEOUT ;;
      inactive_timeout) _vl_val=$CFG_INACTIVE_TIMEOUT ;;
      max_flows) _vl_val=$CFG_MAX_FLOWS ;;
      status_file) _vl_val=$CFG_STATUS_FILE ;;
    esac
    [ -n "$_vl_val" ] || _vl_missing="$_vl_missing '$_vl_key'"
  done
  if [ -n "$_vl_missing" ]; then
    VALIDATE_ERROR="config_invalid: missing required key(s):$_vl_missing"
    return 1
  fi
  return 0
}

find_openable_bpf() {
  # Prints the first openable bpf device under $VIGIL_FLOW_BPF_DIR, or
  # returns 1 when there is none. An unmatched glob stays literal and fails
  # the -e test, so an empty directory is simply "no devices".
  for _bpf in "$VIGIL_FLOW_BPF_DIR"/bpf*; do
    [ -e "$_bpf" ] || continue
    if : < "$_bpf" 2>/dev/null; then
      printf '%s\n' "$_bpf"
      return 0
    fi
  done
  return 1
}

assert_bpf_available() {
  # The runbook's first stop (spec): if the devfs grant is gone — e.g. a
  # firmware upgrade rewrote /etc/devfs.rules — the sensor must say exactly
  # that instead of running blind.
  VALIDATE_ERROR=''
  find_openable_bpf >/dev/null 2>&1 || {
    VALIDATE_ERROR="bpf_missing: no openable $VIGIL_FLOW_BPF_DIR/bpf* device (is the [devfsrules_vigil_flow] grant in /etc/devfs.rules?)"
    return 1
  }
}

capture_interfaces_exist() {
  # Non-VNET jail shares the host network stack, so the host's ifconfig -l
  # is authoritative for interface existence.
  VALIDATE_ERROR=''
  _ci_host_ifaces=$("$VIGIL_FLOW_IFCONFIG" -l 2>/dev/null) || {
    VALIDATE_ERROR="interface_check_failed: cannot list host interfaces with $VIGIL_FLOW_IFCONFIG"
    return 1
  }
  for _ci_iface in $(printf '%s' "$CFG_CAPTURE_INTERFACES" | tr ',' ' '); do
    case " $_ci_host_ifaces " in
      *" $_ci_iface "*) ;;
      *)
        VALIDATE_ERROR="interface_missing: capture interface '$_ci_iface' does not exist on the host stack"
        return 1
        ;;
    esac
  done
}

assert_binaries_available() {
  # Capture cannot work without the exporter. Both ship inside the jail via
  # the installer's `pkg -r` step (locked decision 6).
  VALIDATE_ERROR=''
  [ -x "$VIGIL_FLOW_SOFTFLOWD" ] || {
    VALIDATE_ERROR="softflowd_missing: $VIGIL_FLOW_SOFTFLOWD is not executable (install_softflowd runs in the jail root)"
    return 1
  }
  [ -x "$VIGIL_FLOW_SOFTFLOWCTL" ] || {
    VALIDATE_ERROR="softflowctl_missing: $VIGIL_FLOW_SOFTFLOWCTL is not executable"
    return 1
  }
}

collector_is_resolvable() {
  # Advisory only (spec): a firewalled or unresolvable collector must never
  # prevent capture from starting. IP literals need no resolution; hostnames
  # are resolved with getent when available. Callers print the advisory and
  # move on; runtime export failures surface through statistics polling.
  case $CFG_COLLECTOR_HOST in
    '' | *[!0-9.]*)
      command -v getent >/dev/null 2>&1 || return 0
      getent hosts "$CFG_COLLECTOR_HOST" >/dev/null 2>&1 || return 1
      ;;
  esac
  return 0
}

run_validation_gate() {
  # The full VALIDATE-phase gate, shared by the supervisor and ctl validate:
  # config grammar, value ranges, required keys, host binaries, interface
  # existence, and an openable bpf device. On failure the named cause is in
  # VALIDATE_ERROR.
  load_config || return 1
  validate_loaded_config || return 1
  assert_binaries_available || return 1
  capture_interfaces_exist || return 1
  assert_bpf_available || return 1
  return 0
}

build_softflowd_args() {
  # Pure function (spec sketch): requires CAP_IFACE COLLECTOR_HOST
  # COLLECTOR_PORT NF_VERSION ACTIVE_TIMEOUT INACTIVE_TIMEOUT MAX_FLOWS
  # PIDFILE CTLFILE; prints the exact softflowd argv, one argument per line.
  # Flag mapping verified against softflowd(8): -d foreground, -i interface,
  # -n collector host:port, -v 9 NetFlow v9 / -v 10 IPFIX, -t name=seconds
  # timeouts, -m max tracked flows, -p pidfile, -c control socket.
  [ -n "${CAP_IFACE:-}" ] || return 1
  [ -n "${COLLECTOR_HOST:-}" ] || return 1
  [ -n "${COLLECTOR_PORT:-}" ] || return 1
  [ -n "${PIDFILE:-}" ] || return 1
  [ -n "${CTLFILE:-}" ] || return 1
  case ${NF_VERSION:-} in
    9) _bf_ver=9 ;;
    ipfix) _bf_ver=10 ;;
    *) return 1 ;;
  esac
  printf '%s\n' \
    -d \
    -i "$CAP_IFACE" \
    -n "${COLLECTOR_HOST}:${COLLECTOR_PORT}" \
    -v "$_bf_ver" \
    -t "active=${ACTIVE_TIMEOUT}" -t "inactive=${INACTIVE_TIMEOUT}" \
    -m "$MAX_FLOWS" \
    -p "$PIDFILE" -c "$CTLFILE"
}

parse_flows_total() {
  # $1 = `softflowctl statistics` output. Prints the cumulative flow count
  # (active + expired; every tracked flow eventually expires) and returns 1
  # when the expected counters are missing, so a poll of garbage output is
  # treated as unsuccessful rather than zeroing the total.
  _pf_active=$(printf '%s\n' "$1" | sed -n 's/^Number of active flows: *\([0-9][0-9]*\).*/\1/p' | head -n 1)
  _pf_expired=$(printf '%s\n' "$1" | sed -n 's/^Flows expired: *\([0-9][0-9]*\).*/\1/p' | head -n 1)
  [ -n "$_pf_active" ] && [ -n "$_pf_expired" ] || return 1
  printf '%s\n' $((_pf_active + _pf_expired))
}

pidfile_for() {
  # $1 = interface; per-child pidfile (suffixed per interface so multiple
  # capture interfaces never clobber each other).
  printf '%s.%s' "$VIGIL_FLOW_SOFTFLOWD_PIDFILE" "$1"
}

ctlfile_for() {
  # $1 = interface; per-child softflowd control socket.
  printf '%s.%s' "$VIGIL_FLOW_SOFTFLOWD_CTLFILE" "$1"
}

child_get() {
  # $1 = interface; sets C_PID / C_ATTEMPTS from the registry (empty when
  # the interface has no registry entry).
  C_PID=''
  C_ATTEMPTS=''
  [ -n "$CHILDREN" ] || return 0
  while IFS='|' read -r _cg_iface _cg_pid _cg_attempts _cg_flows; do
    [ -n "$_cg_iface" ] || continue
    if [ "$_cg_iface" = "$1" ]; then
      C_PID=$_cg_pid
      C_ATTEMPTS=$_cg_attempts
      return 0
    fi
  done <<EOF
$CHILDREN
EOF
  return 0
}

child_set() {
  # $1 = interface, $2 = pid, $3 = attempts, $4 = flows; upserts the
  # registry line for the interface.
  _cs_rest=''
  [ -n "$CHILDREN" ] || CHILDREN=''
  while IFS='|' read -r _cs_iface _cs_pid _cs_attempts _cs_flows; do
    [ -n "$_cs_iface" ] || continue
    if [ "$_cs_iface" = "$1" ]; then
      continue # replaced below
    fi
    _cs_rest="$_cs_rest$_cs_iface|$_cs_pid|$_cs_attempts|$_cs_flows
"
  done <<EOF
$CHILDREN
EOF
  CHILDREN="$_cs_rest$1|$2|$3|$4
"
}

sum_registry_flows() {
  # Prints the sum of the per-interface flow counters.
  _sr_total=0
  [ -n "$CHILDREN" ] || {
    printf '0\n'
    return 0
  }
  while IFS='|' read -r _sr_iface _sr_pid _sr_attempts _sr_flows; do
    [ -n "$_sr_iface" ] || continue
    case $_sr_flows in
      '' | *[!0-9]*) _sr_flows=0 ;;
    esac
    _sr_total=$((_sr_total + _sr_flows))
  done <<EOF
$CHILDREN
EOF
  printf '%s\n' "$_sr_total"
}

registry_all_alive() {
  # True when every registered child process is alive.
  [ -n "$CHILDREN" ] || return 1
  while IFS='|' read -r _ra_iface _ra_pid _ra_attempts _ra_flows; do
    [ -n "$_ra_iface" ] || continue
    kill -0 "$_ra_pid" 2>/dev/null || return 1
  done <<EOF
$CHILDREN
EOF
  return 0
}

set_state() {
  # $1 = new state. Records the transition and rewrites the health file —
  # every transition rewrites the JSON (the supervisor's one contract).
  STATE=$1
  LAST_TRANSITION=$(now_utc)
  write_health
}

degrade() {
  # $1 = named cause. DEGRADED always carries a named cause; the supervisor
  # keeps running and re-checks for recovery on every tick.
  DEGRADED_CAUSE=$1
  set_state DEGRADED
}

write_supervisor_pidfile() {
  mkdir -p "$(dirname "$VIGIL_FLOW_SUPERVISOR_PIDFILE")" 2>/dev/null
  printf '%s\n' "$$" > "$VIGIL_FLOW_SUPERVISOR_PIDFILE" ||
    die "cannot write supervisor pidfile $VIGIL_FLOW_SUPERVISOR_PIDFILE"
}

write_health() {
  # Rewrites the health JSON atomically: temp file + rename, so a reader
  # (status, collector dashboards) never sees a partial write. Fields follow
  # the schema in docs/design/data.md; softflowd_pids (per-interface map)
  # is a documented extension for multi-interface capture.
  _wh_dir=$(dirname "$STATUS_FILE")
  mkdir -p "$_wh_dir" 2>/dev/null || {
    err "cannot create the status directory $_wh_dir: the health file cannot be written"
    exit 1
  }
  _wh_tmp=$STATUS_FILE.tmp.$$
  _wh_first_pid=''
  if [ -n "$CHILDREN" ]; then
    _wh_first_pid=$(printf '%s\n' "$CHILDREN" | while IFS='|' read -r _wp_i _wp_p _wp_a _wp_f; do
      [ -n "$_wp_i" ] || continue
      case $_wp_p in '' | *[!0-9]*) continue ;; esac
      printf '%s' "$_wp_p"
      break
    done)
  fi
  _wh_pids='{'
  _wh_sep=''
  if [ -n "$CHILDREN" ]; then
    while IFS='|' read -r _wp_i _wp_p _wp_a _wp_f; do
      [ -n "$_wp_i" ] || continue
      case $_wp_p in '' | *[!0-9]*) continue ;; esac
      _wh_pids="$_wh_pids$_wh_sep$(json_string "$_wp_i"): $_wp_p"
      _wh_sep=', '
    done <<EOF
$CHILDREN
EOF
  fi
  _wh_pids="$_wh_pids}"
  _wh_collector=''
  if [ -n "$CFG_COLLECTOR_HOST" ] && [ -n "$CFG_COLLECTOR_PORT" ]; then
    _wh_collector="$CFG_COLLECTOR_HOST:$CFG_COLLECTOR_PORT"
  fi
  _wh_cause=$DEGRADED_CAUSE
  if ! printf '%s\n' \
    '{' \
    "  \"state\": $(json_string "$STATE")," \
    "  \"softflowd_pid\": ${_wh_first_pid:-null}," \
    "  \"softflowd_pids\": $_wh_pids," \
    "  \"collector\": $(json_or_null "$_wh_collector")," \
    "  \"export_version\": $(json_or_null "$CFG_NF_VERSION")," \
    "  \"capture_interfaces\": $(json_iface_array "$CFG_CAPTURE_INTERFACES")," \
    "  \"flows_total\": $FLOWS_TOTAL," \
    "  \"consecutive_restart_failures\": $CONSECUTIVE_RESTART_FAILURES," \
    "  \"degraded_cause\": $(json_string "$(sanitize_detail "$_wh_cause")")," \
    "  \"last_stats_poll\": $(json_or_null "$LAST_STATS_POLL")," \
    "  \"last_transition\": $(json_or_null "$LAST_TRANSITION")" \
    '}' > "$_wh_tmp" ||
    ! mv -f "$_wh_tmp" "$STATUS_FILE"; then
    rm -f "$_wh_tmp" 2>/dev/null
    err "cannot write the health file $STATUS_FILE"
    exit 1
  fi
}

spawn_child() {
  # $1 = interface. Builds the softflowd argv and launches the child;
  # sets CHILD_PID on success, returns 1 with VALIDATE_ERROR on failure.
  _sc_iface=$1
  _sc_pidfile=$(pidfile_for "$_sc_iface")
  _sc_ctlfile=$(ctlfile_for "$_sc_iface")
  rm -f "$_sc_pidfile" "$_sc_ctlfile" 2>/dev/null
  _sc_argv=$(CAP_IFACE=$_sc_iface \
    PIDFILE=$_sc_pidfile CTLFILE=$_sc_ctlfile \
    build_softflowd_args) || {
    VALIDATE_ERROR="softflowd_args_failed: cannot build the softflowd command line for '$_sc_iface'"
    return 1
  }
  # Rebuild the newline-separated argv as positional parameters — no eval,
  # so a config value can never become code.
  set --
  while IFS= read -r _sc_arg; do
    [ -n "$_sc_arg" ] || continue
    set -- "$@" "$_sc_arg"
  done <<EOF
$_sc_argv
EOF
  "$VIGIL_FLOW_SOFTFLOWD" "$@" &
  CHILD_PID=$!
  child_set "$_sc_iface" "$CHILD_PID" 0 0
  return 0
}

spawn_all_children() {
  _sa_iface=''
  for _sa_iface in $(printf '%s' "$CFG_CAPTURE_INTERFACES" | tr ',' ' '); do
    spawn_child "$_sa_iface" || return 1
  done
  return 0
}

stop_child() {
  # $1 = interface. Best-effort graceful stop of one child: softflowctl
  # shutdown asks softflowd to flush and export remaining flows before
  # exiting; escalate to signals on a bounded schedule. The || true on wait
  # is deliberate: wait fails when the pid is not our child or is already
  # reaped, which is exactly the tolerated case here.
  _st_iface=$1
  child_get "$_st_iface"
  [ -n "$C_PID" ] || return 0
  case $C_PID in '' | *[!0-9]*) return 0 ;; esac
  "$VIGIL_FLOW_SOFTFLOWCTL" -c "$(ctlfile_for "$_st_iface")" shutdown >/dev/null 2>&1 ||
    true
  _st_i=0
  while [ "$_st_i" -lt 20 ]; do
    kill -0 "$C_PID" 2>/dev/null || break
    sleep 0.1
    _st_i=$((_st_i + 1))
  done
  if kill -0 "$C_PID" 2>/dev/null; then
    kill -TERM "$C_PID" 2>/dev/null || true
    _st_i=0
    while [ "$_st_i" -lt 20 ]; do
      kill -0 "$C_PID" 2>/dev/null || break
      sleep 0.1
      _st_i=$((_st_i + 1))
    done
  fi
  kill -KILL "$C_PID" 2>/dev/null || true
  wait "$C_PID" 2>/dev/null || true
  rm -f "$(pidfile_for "$_st_iface")" "$(ctlfile_for "$_st_iface")" 2>/dev/null || true
}

stop_all_children() {
  [ -n "$CHILDREN" ] || return 0
  while IFS='|' read -r _sa_iface _sa_pid _sa_attempts _sa_flows; do
    [ -n "$_sa_iface" ] || continue
    stop_child "$_sa_iface"
  done <<EOF
$CHILDREN
EOF
  CHILDREN=''
}

restart_backoff_seconds() {
  # $1 = attempt number (1-based). Exponential backoff, capped — the spec's
  # "backoff, bounded retries": the cap keeps a crash loop from sleeping
  # forever, the attempt bound below stops it from retrying forever.
  _rb=$(( 1 << ($1 - 1) ))
  [ "$_rb" -gt "$VIGIL_FLOW_MAX_BACKOFF" ] && _rb=$VIGIL_FLOW_MAX_BACKOFF
  printf '%s\n' "$_rb"
}

supervise_children() {
  # Liveness pass over the registry: restart dead children with backoff,
  # increment the consecutive-failure counter, and degrade with a named
  # cause when the restart bound is exhausted.
  _sc_restarted=0
  _sc_lines=''
  [ -n "$CHILDREN" ] || return 0
  while IFS='|' read -r _sc_iface _sc_pid _sc_attempts _sc_flows; do
    [ -n "$_sc_iface" ] || continue
    if kill -0 "$_sc_pid" 2>/dev/null; then
      _sc_lines="$_sc_lines$_sc_iface|$_sc_pid|0|$_sc_flows
"
      continue
    fi
    # Child died: reap it (tolerated failure if already reaped) and restart.
    wait "$_sc_pid" 2>/dev/null || true
    _sc_attempts=$((_sc_attempts + 1))
    CONSECUTIVE_RESTART_FAILURES=$((CONSECUTIVE_RESTART_FAILURES + 1))
    if [ "$_sc_attempts" -gt "$VIGIL_FLOW_MAX_CONSEC_RESTARTS" ]; then
      degrade "restart_exhausted: softflowd for '$_sc_iface' failed $_sc_attempts consecutive starts (last pid $_sc_pid)"
      return 0
    fi
    set_state RESTARTING
    sleep "$(restart_backoff_seconds "$_sc_attempts")"
    spawn_child "$_sc_iface" || {
      degrade "$VALIDATE_ERROR"
      return 0
    }
    _sc_restarted=1
    child_get "$_sc_iface"
    _sc_lines="$_sc_lines$_sc_iface|$C_PID|$C_ATTEMPTS|$_sc_flows
"
  done <<EOF
$CHILDREN
EOF
  CHILDREN=$_sc_lines
  if [ "$_sc_restarted" -eq 0 ] && [ "$CONSECUTIVE_RESTART_FAILURES" -ne 0 ]; then
    # Every child confirmed alive: the failure streak is over.
    CONSECUTIVE_RESTART_FAILURES=0
  fi
  return 0
}

poll_stats() {
  # Poll each child's control socket and refresh the flow counters. A
  # per-interface poll failure keeps that interface's last known count —
  # including an unreachable collector, which surfaces here instead of at
  # startup (spec: export problems are a stats-poll concern).
  [ -n "$CHILDREN" ] || return 0
  _ps_any_ok=0
  _ps_lines=''
  while IFS='|' read -r _ps_iface _ps_pid _ps_attempts _ps_flows; do
    [ -n "$_ps_iface" ] || continue
    case $_ps_flows in '' | *[!0-9]*) _ps_flows=0 ;; esac
    if kill -0 "$_ps_pid" 2>/dev/null; then
      if _ps_stats=$("$VIGIL_FLOW_SOFTFLOWCTL" -c "$(ctlfile_for "$_ps_iface")" statistics 2>/dev/null) &&
        _ps_flows_new=$(parse_flows_total "$_ps_stats"); then
        _ps_flows=$_ps_flows_new
        _ps_any_ok=1
      fi
    fi
    _ps_lines="$_ps_lines$_ps_iface|$_ps_pid|$_ps_attempts|$_ps_flows
"
  done <<EOF
$CHILDREN
EOF
  CHILDREN=$_ps_lines
  if [ "$_ps_any_ok" -eq 1 ]; then
    LAST_STATS_POLL=$(now_utc)
  fi
  FLOWS_TOTAL=$(sum_registry_flows)
  return 0
}

supervise_recover() {
  # DEGRADED tick: re-run the whole gate; a fixed cause resumes supervision
  # automatically with no operator restart (the spec's dashed recovery edge
  # is honored either way — reconfigure re-runs this same gate).
  if run_validation_gate && spawn_all_children; then
    CONSECUTIVE_RESTART_FAILURES=0
    DEGRADED_CAUSE=''
    set_state RUNNING
    return 0
  fi
  [ -n "$VALIDATE_ERROR" ] && DEGRADED_CAUSE=$VALIDATE_ERROR
  write_health
  return 0
}

supervise_once() {
  # One poll cycle. No `set -e`: a supervisor must survive unexpected
  # command failures, so every fallible command here is handled explicitly.
  if [ "$STATE" = DEGRADED ]; then
    supervise_recover
    return 0
  fi
  # Runtime prerequisites (spec: lost bpf or a vanished interface must be
  # named in the health file, never run blind).
  assert_bpf_available || {
    stop_all_children
    degrade "$VALIDATE_ERROR"
    return 0
  }
  capture_interfaces_exist || {
    stop_all_children
    degrade "$VALIDATE_ERROR"
    return 0
  }
  supervise_children
  if [ "$STATE" = DEGRADED ]; then
    write_health
    return 0
  fi
  poll_stats
  if [ "$STATE" = RESTARTING ] && registry_all_alive; then
    CONSECUTIVE_RESTART_FAILURES=0
    set_state RUNNING
    return 0
  fi
  write_health
  return 0
}

graceful_stop() {
  # SIGTERM handler (jail exec.stop and ctl stop both land here): flush and
  # stop the children, then leave one final truthful health record.
  trap - TERM INT
  stop_all_children
  rm -f "$VIGIL_FLOW_SUPERVISOR_PIDFILE" 2>/dev/null || true
  STATE=STOPPED
  write_health
  exit 0
}

run_supervisor() {
  # Deliberately no `set -e`: every fallible command is handled explicitly,
  # because an unhandled nonzero must degrade the sensor, not kill it dark.
  set -u
  trap graceful_stop TERM INT
  write_supervisor_pidfile
  set_state BOOTING
  # BOOT exits when the config file is found and readable (spec); a missing
  # or unreadable file takes the BOOT -> DEGRADED edge directly.
  if [ ! -f "$VIGIL_FLOW_CONFIG" ] || [ ! -r "$VIGIL_FLOW_CONFIG" ]; then
    degrade "config_missing: no readable configuration file at $VIGIL_FLOW_CONFIG"
    supervise_loop
    return 0
  fi
  set_state VALIDATE
  # VALIDATE runs the full gate: grammar, ranges, required keys, binaries,
  # interface existence, and an openable bpf device.
  if run_validation_gate && spawn_all_children; then
    CONSECUTIVE_RESTART_FAILURES=0
    DEGRADED_CAUSE=''
    set_state RUNNING
  else
    degrade "$VALIDATE_ERROR"
  fi
  supervise_loop
  return 0
}

supervise_loop() {
  while :; do
    sleep "$VIGIL_FLOW_POLL_INTERVAL"
    supervise_once
  done
}

main() {
  set -u
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
      run)
        run_supervisor
        exit $?
        ;;
      *)
        die "unknown option or command: $1 (run with --help)"
        ;;
    esac
  done
  die "missing required command: run (run with --help)"
}

if [ "${VIGIL_FLOW_SKIP_MAIN:-0}" = "1" ]; then
  : # sourced for hermetic testing — define functions only
else
  main "$@"
fi
