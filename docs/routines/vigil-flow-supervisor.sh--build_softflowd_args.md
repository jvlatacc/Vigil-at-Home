# `build_softflowd_args` — vigil-flow-supervisor.sh

**Script:** `appliance/opnsense/share/vigil-flow-supervisor.sh`. builds the exact softflowd argv from the validated config.

```sh
build_softflowd_args() {
  # Pure function (spec sketch): requires CAP_IFACE PIDFILE CTLFILE and the
  # parsed config (CFG_COLLECTOR_HOST CFG_COLLECTOR_PORT CFG_NF_VERSION
  # CFG_ACTIVE_TIMEOUT CFG_INACTIVE_TIMEOUT CFG_MAX_FLOWS); prints the exact
  # softflowd argv, one argument per line. Reading the CFG_* values directly
  # keeps one source of truth — there is no second mapping layer to drift
  # from what load_config validated. Flag mapping verified against
  # softflowd(8): -d foreground, -i interface, -n collector host:port,
  # -v 9 NetFlow v9 / -v 10 IPFIX, -t name=seconds timeouts, -m max tracked
  # flows, -p pidfile, -c control socket.
  [ -n "${CAP_IFACE:-}" ] || return 1
  [ -n "${CFG_COLLECTOR_HOST:-}" ] || return 1
  [ -n "${CFG_COLLECTOR_PORT:-}" ] || return 1
  [ -n "${PIDFILE:-}" ] || return 1
  [ -n "${CTLFILE:-}" ] || return 1
  case ${CFG_NF_VERSION:-} in
    9) _bf_ver=9 ;;
    ipfix) _bf_ver=10 ;;
    *) return 1 ;;
  esac
  printf '%s\n' \
    -d \
    -i "$CAP_IFACE" \
    -n "${CFG_COLLECTOR_HOST}:${CFG_COLLECTOR_PORT}" \
    -v "$_bf_ver" \
    -t "active=${CFG_ACTIVE_TIMEOUT}" -t "inactive=${CFG_INACTIVE_TIMEOUT}" \
    -m "$CFG_MAX_FLOWS" \
    -p "$PIDFILE" -c "$CTLFILE"
}
```

## Purpose

Pure function: reads the parsed `CFG_*` values plus `CAP_IFACE`, `PIDFILE`, `CTLFILE`, and prints the softflowd command line one argument per line: `-d -i IFACE -n collector:port -v 9|10 -t active=... -t inactive=... -m max_flows -p pidfile -c ctlfile`. Flag mapping verified against softflowd(8): `-d` foreground, `-v 9` NetFlow v9, `-v 10` IPFIX. Reading the `CFG_*` values directly keeps one source of truth — no second mapping layer to drift.

## Inputs and outputs

- Inputs: `CAP_IFACE`, `PIDFILE`, `CTLFILE`, `CFG_COLLECTOR_HOST`, `CFG_COLLECTOR_PORT`, `CFG_NF_VERSION`, `CFG_ACTIVE_TIMEOUT`, `CFG_INACTIVE_TIMEOUT`, `CFG_MAX_FLOWS`.
- Output: the argv, one argument per line, on stdout.
- Return status: 0 built; 1 when a required variable is missing or the version is neither `9` nor `ipfix`.

## Side effects

None (pure).

## Failure modes and exit codes

Returns 1 before any child process starts when a required variable is empty or the export version is unknown.

## Tests covering it

All six argbuilder.bats cases: "arg builder emits the exact spec argv for the v9 fixture", "arg builder maps ipfix to softflowd -v 10", "arg builder carries the configured timeout tunables", "arg builder refuses a missing capture interface", "arg builder refuses a missing collector host", "arg builder refuses an unknown export version".

## Linked decisions

- [0002 — NetFlow v9 over UDP, collector port 2550](../decisions/0002-netflow-v9-udp-port-2550.md) — NetFlow v9 over UDP, port 2550 by default; IPFIX config-compatible
