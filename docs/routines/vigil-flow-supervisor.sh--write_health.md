# `write_health` — vigil-flow-supervisor.sh

**Script:** `appliance/opnsense/share/vigil-flow-supervisor.sh`. rewrites the health JSON atomically.

```sh
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
```

## Purpose

Builds the health object from the current state and writes it to a temp file, then renames it over `$STATUS_FILE` — a reader never sees a partial file. Fields follow the schema in `docs/design/data.md`, plus the shipped extensions: `softflowd_pids` (a per-interface pid map for multi-interface capture), `degraded_cause` (always present, empty when healthy, sanitized through `sanitize_detail`), and the `STOPPED` state.

## Inputs and outputs

- Output: `$STATUS_FILE` (default `/var/db/vigil-flow/status.json`).
- Fields: `state`, `softflowd_pid`, `softflowd_pids`, `collector`, `export_version`, `capture_interfaces`, `flows_total`, `consecutive_restart_failures`, `degraded_cause`, `last_stats_poll`, `last_transition`.

## Side effects

Creates the status directory if needed; atomically replaces the file.

## Failure modes and exit codes

The one fatal status failure: when the status directory cannot be created, or the temp file cannot be written or renamed, the supervisor logs and exits 1 — a sensor that cannot speak its state must not keep running silent.

## Tests covering it

"health output is valid JSON" parses the file as JSON; the start/stop/degrade cases assert the field values.

## Linked decisions

- [0001 — Capture runs entirely inside the jail](../decisions/0001-jail-contained-capture-non-vnet-bpf.md) — the health file is the sensor's voice — it always tells the truth
- [0004 — POSIX sh runtime, with the shellcheck + bats CI job](../decisions/0004-posix-sh-runtime-shell-ci.md) — atomic temp-file + rename in plain sh
