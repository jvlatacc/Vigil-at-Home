# `write_sensor_config` — install.sh

**Script:** `appliance/opnsense/install.sh`. Emits the sensor configuration
inside the jail root.

```sh
write_sensor_config() {
  # Emits the POSIX key = value sensor config inside the jail root, using
  # the exact keys from the component spec.
  mkdir -p "$JAIL_ROOT/etc" || return 1
  cat > "$JAIL_ROOT/etc/vigil-flow.conf" <<EOF
# vigil-flow sensor configuration (installed by appliance/opnsense/install.sh)

# Capture on these host interfaces, seen through unhidden /dev/bpf*.
capture_interfaces = "$INTERFACES"

# Off-device NetFlow collector.
collector_host = "$COLLECTOR_HOST"
collector_port = "$COLLECTOR_PORT"

# 9 | ipfix (maps to softflowd -v 9 | -v 10)
netflow_version = "$NF_VERSION"

# Flow timeouts and limits (passed to softflowd -t / -m).
active_timeout = "300"
inactive_timeout = "30"
max_flows = "8192"

# Health/status output (JSON, rewritten on every transition and stats poll).
status_file = "/var/db/vigil-flow/status.json"
EOF
}
```

## Purpose

Write the single source of truth the sensor reads: the POSIX `key = value`
file the component spec defines, with the installer's validated flags
substituted for the four operator-chosen keys and the spec's fixed values for
the rest (timeouts 300/30, 8192 flows, the status-file path).

## Inputs and outputs

- Inputs: `INTERFACES`, `COLLECTOR_HOST`, `COLLECTOR_PORT`, `NF_VERSION`
  (from `parse_args`), `JAIL_ROOT`.
- Output: `$JAIL_ROOT/etc/vigil-flow.conf`.
- Return status: 0 on success, 1 when the directory cannot be created (main
  wraps with `die "cannot write the sensor configuration"`).

## Side effects

Creates `$JAIL_ROOT/etc` and overwrites the sensor config. The file lives
inside the jail root, so it is part of the `tree:$JAIL_ROOT` manifest entry
and disappears with the jail on uninstall.

## Failure modes and exit codes

Exit 1 via `main`'s `die` when the directory cannot be created or the file
cannot be written.

## Tests covering it

`appliance/opnsense/tests/installer.bats`:
"write_sensor_config emits the exact spec keys from the flags" — asserts all
eight keys with the flag values substituted.
`appliance/opnsense/tests/fragments.bats`:
"config template carries the exact spec keys" — the shipped reference
template (`share/vigil-flow.conf`) carries the same keys.

## Linked decisions

- [0002 — NetFlow v9 over UDP, collector port 2550](../decisions/0002-netflow-v9-udp-port-2550.md)
  (collector and version keys)
- [0001 — Capture runs entirely inside the jail](../decisions/0001-jail-contained-capture-non-vnet-bpf.md)
  (capture_interfaces and the config's jail-root location)
