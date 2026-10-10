# `spawn_child` — vigil-flow-supervisor.sh

**Script:** `appliance/opnsense/share/vigil-flow-supervisor.sh`. launches one softflowd child for one interface.

```sh
spawn_child() {
  # $1 = interface, $2 = consecutive-attempt count (0 on a fresh spawn,
  # escalating across restarts so the restart bound can exhaust). Builds
  # the softflowd argv and launches the child; sets CHILD_PID on success,
  # returns 1 with VALIDATE_ERROR on failure.
  _sc_iface=$1
  _sc_attempts=${2:-0}
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
  "$VIGIL_FLOW_SOFTFLOWD" "$@" 3<&- 4<&- 5<&- 6<&- 7<&- 8<&- 9<&- &
  CHILD_PID=$!
  child_set "$_sc_iface" "$CHILD_PID" "$_sc_attempts" 0
  return 0
}
```

## Purpose

Builds the argv (`build_softflowd_args`), rebuilds it as positional parameters without eval — a config value can never become code — and starts softflowd in the background with file descriptors 3-9 closed. The attempt count escalates across restarts so the restart bound can exhaust.

## Inputs and outputs

- Input: `$1` interface, `$2` attempt count (0 on a fresh spawn).
- Outputs: `CHILD_PID`; registers the child via `child_set`.
- Return status: 0 launched; 1 with `softflowd_args_failed: ...` when the argv cannot be built.

## Side effects

Starts a softflowd process; removes stale per-interface pidfile/control-socket files first.

## Failure modes and exit codes

Returns 1 when `build_softflowd_args` fails; the caller degrades with the cause.

## Tests covering it

"ctl start reaches RUNNING and the stub records the exact spec argv" (the stub records the exact argv the builder produced).

## Linked decisions

- [0001 — Capture runs entirely inside the jail](../decisions/0001-jail-contained-capture-non-vnet-bpf.md) — capture runs inside the jail, one child per interface
- [0002 — NetFlow v9 over UDP, collector port 2550](../decisions/0002-netflow-v9-udp-port-2550.md) — the argv is the NetFlow v9 export pipeline
