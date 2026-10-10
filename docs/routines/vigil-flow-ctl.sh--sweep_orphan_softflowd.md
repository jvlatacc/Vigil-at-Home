# `sweep_orphan_softflowd` — vigil-flow-ctl.sh

**Script:** `appliance/opnsense/share/vigil-flow-ctl.sh`. removes softflowd orphans and stale per-interface files.

```sh
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
```

## Purpose

When the supervisor died without a graceful stop, its softflowd children can outlive it. The sweep TERMs any live process named by a per-interface pidfile and removes the pidfiles and control sockets (the per-interface suffixes make the glob exact). The deliberate `|| true`s swallow only the already-dead cases.

## Inputs and outputs

- Effects: orphan softflowd processes signaled; their pidfiles and control sockets removed.

## Side effects

Sends signals; removes stale files.

## Failure modes and exit codes

Never fails the caller.

## Tests covering it

"ctl stop leaves STOPPED, no supervisor, and no children" asserts no softflowd survives a stop.

## Linked decisions

- [0001 — Capture runs entirely inside the jail](../decisions/0001-jail-contained-capture-non-vnet-bpf.md) — stop must leave nothing half-alive behind the jail
