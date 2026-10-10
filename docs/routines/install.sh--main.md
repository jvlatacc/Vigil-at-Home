# `main` — install.sh

**Script:** `appliance/opnsense/install.sh`. Orchestrates the whole install;
the only caller of every other routine.

```sh
main() {
  set -eu

  [ "$(id -u)" -eq 0 ] || die "this installer must run as root"
  command -v opnsense-version >/dev/null 2>&1 ||
    die "opnsense-version not found: this installer must run on an OPNsense appliance"

  parse_args "$@" || die "invalid arguments (run with --help)"
  detect_abi
  assert_interfaces_exist

  mkdir -p "$VIGIL_ROOT" || die "cannot create $VIGIL_ROOT"
  write_manifest || die "cannot write $MANIFEST_FILE"

  printf '%s: provisioning %s from %s (ABI %s)\n' "${0##*/}" "$JAIL_NAME" "$BASE_TXZ_URL" "$PKG_ABI"
  fetch_base_txz
  extract_base_txz
  install_softflowd

  append_devfs_fragment "$DEVFS_RULES_FILE" || die "cannot append the devfs fragment to $DEVFS_RULES_FILE"
  ensure_jail_conf_include "$JAIL_CONF_INCLUDE_FILE" || die "cannot ensure the jail.conf include in $JAIL_CONF_INCLUDE_FILE"
  write_jail_conf || die "cannot write $JAIL_CONF_DIR/vigil-flow.conf"
  write_sensor_config || die "cannot write the sensor configuration"
  write_configd_action || die "cannot write $ACTION_DIR/actions_vigil-flow.conf"
  copy_host_wrapper

  printf '%s: done. Next steps:\n' "${0##*/}"
  printf '  1. service configd restart   # pick up the vigil-flow actions\n'
  printf '  2. install the vigil-flow daemon scripts (sensor component), then:\n'
  printf '  3. service jail start %s && configctl %s status\n' "$JAIL_NAME" "$JAIL_NAME"
}
```

## Purpose

Run the install in a fixed order: verify the environment (root, OPNsense),
validate the flags, detect the ABI, verify the interfaces, write the manifest
first, build the jail userland, then write every host fragment. Ends with the
operator's next steps, including `service configd restart`.

## Inputs and outputs

- Input: the CLI flags (passed through to `parse_args`).
- Output: progress lines and the next-steps list on stdout.
- Return status: 0 on success; 1 via `die` at any guard.

## Side effects

Everything the installer creates: the manifest, the jail userland tree with
softflowd, the devfs fragment, the jail.conf include, the jail fragment, the
sensor config, the configd action file, and the host wrapper. Under `set -eu`,
the first failure stops the run.

## Failure modes and exit codes

Exit 1 with a named cause for: non-root, non-OPNsense host (`opnsense-version`
missing), invalid arguments, ABI detection failure, missing capture
interface, unwritable `$VIGIL_ROOT` or manifest, and each fragment/write
failure wrapped by its step.

## Tests covering it

None directly — the bats suite sources the installer with
`VIGIL_FLOW_SKIP_MAIN=1` (the testing contract in the header) and exercises
the functions individually; `main` itself is on-device verified.

## Linked decisions

- [0001 — Capture runs entirely inside the jail](../decisions/0001-jail-contained-capture-non-vnet-bpf.md)
- [0002 — NetFlow v9 over UDP, collector port 2550](../decisions/0002-netflow-v9-udp-port-2550.md)
- [0005 — No PHP GUI in v1: configd actions plus the ctl surface](../decisions/0005-no-php-gui-configd-actions.md)
- [0006 — Jail userland from base.txz, zero host packages](../decisions/0006-jail-userland-base-txz-softflowd.md)
