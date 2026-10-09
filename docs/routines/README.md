# Appliance routine reference

One Markdown file per routine in the current appliance shell scripts, so the
on-device logic can be replayed without this chat history. Source of truth is
the merged scaffold at `appliance/opnsense/` (commit `be84faa`, PR #2) and the
component spec "OPNsense NetFlow Sensor — Vigil appliance component spec"
(art_4ou8t1mZ).

**Naming convention:** `<script>--<routine>.md`, where `<script>` is the
script's basename (`install.sh`, `uninstall.sh`, `vigil-flow-jail-ctl.sh`) and
`<routine>` is a function definition in it. `vigil-flow-jail-ctl.sh` defines no
functions; its single routine, the whole-body flow, is documented as `main`.

Every routine file carries the same six sections: Purpose, Inputs and outputs,
Side effects, Failure modes and exit codes, Tests covering it, and Linked
decisions. Each was cross-checked against the script text quoted inside it.

The in-jail daemon scripts (`vigil-flow-ctl.sh`, `vigil-flow-supervisor.sh`)
are wired by the installer's `exec.start`/`exec.stop` but do not exist on this
branch yet; they arrive with the sensor-daemon change and will be documented
the same way when they land. Until then the installer provisions but does not
start the jail, as `appliance/opnsense/README.md` states.

## install.sh — installer (26 routines)

Root-run, idempotent provisioner: validates flags, detects the FreeBSD ABI,
builds the jail userland, and writes every host fragment.

| Routine | Role |
| ------------------------------- | ------------------------------------------------------ |
| [`err`](install.sh--err.md) | Script-prefixed error line on stderr |
| [`die`](install.sh--die.md) | Print a named cause and exit 1 |
| [`usage`](install.sh--usage.md) | Print installer help |
| [`is_valid_port`](install.sh--is_valid_port.md) | Port is numeric and within 1-65535 |
| [`is_valid_ipv4`](install.sh--is_valid_ipv4.md) | Dotted-quad IPv4 check |
| [`split_collector`](install.sh--split_collector.md) | Parse `HOST[:PORT]` into host and port |
| [`validate_interfaces`](install.sh--validate_interfaces.md) | Syntax-only check of the interface list |
| [`validate_netflow_version`](install.sh--validate_netflow_version.md) | Accept only `9` or `ipfix` |
| [`parse_args`](install.sh--parse_args.md) | Parse CLI flags into config variables |
| [`arch_from_uname`](install.sh--arch_from_uname.md) | `uname -m` to FreeBSD arch directory |
| [`freebsd_release_from_userland`](install.sh--freebsd_release_from_userland.md) | Userland version to downloadable release |
| [`pkg_abi_for`](install.sh--pkg_abi_for.md) | Release and arch to pkg ABI string |
| [`base_txz_url`](install.sh--base_txz_url.md) | Official base.txz download URL |
| [`detect_abi`](install.sh--detect_abi.md) | Detect userland, release, arch, ABI, URL |
| [`assert_interfaces_exist`](install.sh--assert_interfaces_exist.md) | Runtime check on the host stack |
| [`write_manifest`](install.sh--write_manifest.md) | Record everything the installer creates |
| [`append_devfs_fragment`](install.sh--append_devfs_fragment.md) | Idempotent devfs ruleset append |
| [`ensure_jail_conf_include`](install.sh--ensure_jail_conf_include.md) | Idempotent `jail.conf` include directive |
| [`write_jail_conf`](install.sh--write_jail_conf.md) | Emit the jail fragment |
| [`write_sensor_config`](install.sh--write_sensor_config.md) | Emit the sensor configuration |
| [`write_configd_action`](install.sh--write_configd_action.md) | Register `configctl` actions |
| [`copy_host_wrapper`](install.sh--copy_host_wrapper.md) | Install the jexec wrapper |
| [`fetch_base_txz`](install.sh--fetch_base_txz.md) | Fetch the matching base.txz |
| [`extract_base_txz`](install.sh--extract_base_txz.md) | Untar the jail userland |
| [`install_softflowd`](install.sh--install_softflowd.md) | `pkg -r` softflowd into the jail |
| [`main`](install.sh--main.md) | Orchestrate the whole install |

## uninstall.sh — uninstaller (7 routines)

Manifest-driven clean removal of everything install.sh recorded.

| Routine | Role |
| ------------------------------- | ------------------------------------------------------- |
| [`err`](uninstall.sh--err.md) | Script-prefixed error line on stderr |
| [`die`](uninstall.sh--die.md) | Print a named cause and exit 1 |
| [`usage`](uninstall.sh--usage.md) | Print uninstaller help |
| [`stop_jail`](uninstall.sh--stop_jail.md) | `jail -r` the jail if running |
| [`strip_marked_block`](uninstall.sh--strip_marked_block.md) | Delete a marked fragment block |
| [`process_manifest`](uninstall.sh--process_manifest.md) | Apply every manifest entry |
| [`main`](uninstall.sh--main.md) | Orchestrate the removal |

## vigil-flow-jail-ctl.sh — host wrapper (1 routine)

| Routine | Role |
| --------------------------------- | --------------------------------------------------- |
| [`main`](vigil-flow-jail-ctl.sh--main.md) | Forward `status\|reconfigure` into the jail via jexec |

## Test coverage map

The hermetic bats suite (23 cases, no network, no host modification) lives in
`appliance/opnsense/tests/`:

- `installer.bats` (19 cases): flag parsing and rejections, IPv4 and ABI
  mapping, idempotent fragment handling, generated-file contracts.
- `fragments.bats` (4 cases): the shipped devfs, jail and config reference
  fragments match the documented contracts, and the wrapper forwards only
  `status` and `reconfigure`.

Routines that need a real OPNsense host or the network (`detect_abi`,
`assert_interfaces_exist`, `fetch_base_txz`, `extract_base_txz`,
`install_softflowd`, `main` in both scripts, `stop_jail`,
`strip_marked_block`, `process_manifest`, `write_manifest`,
`write_configd_action`, `copy_host_wrapper`) have no direct bats case; each
routine file says so and names the on-device check that covers it instead.
