# `poll_stats` — vigil-flow-supervisor.sh

**Script:** `appliance/opnsense/share/vigil-flow-supervisor.sh`. refreshes flow counters from each child's control socket.

```sh
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
```

## Purpose

Per interface: if the child is alive, `softflowctl statistics` is parsed (`parse_flows_total`) and the counter updated; a failed poll keeps that interface's last known count — including an unreachable collector, which surfaces here instead of at startup (spec: export problems are a stats-poll concern). Any successful poll stamps `last_stats_poll`; `flows_total` is recomputed from the registry.

## Inputs and outputs

- Input: `$CHILDREN`.
- Effects: updates the registry counters, `LAST_STATS_POLL`, `FLOWS_TOTAL`.

## Side effects

Talks to the control sockets; does not write the health file itself.

## Failure modes and exit codes

Never fails the caller; per-interface failures keep the last known count.

## Tests covering it

"an unreachable collector never blocks startup (stats-poll concern)" (the unreachable collector never blocks or zeroes anything).

## Linked decisions

- [0002 — NetFlow v9 over UDP, collector port 2550](../decisions/0002-netflow-v9-udp-port-2550.md) — export problems are a statistics concern, not a startup blocker
