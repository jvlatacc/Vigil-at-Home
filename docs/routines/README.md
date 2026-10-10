# Appliance routine reference

One Markdown file per routine in the current appliance shell scripts, so the
on-device logic can be replayed without this chat history. Source of truth is
the merged appliance code at `appliance/opnsense/` (scaffold PR #2,
`be84faa`; daemon PR #29, `073c29e`) and the
component spec "OPNsense NetFlow Sensor — Vigil appliance component spec"
(art_4ou8t1mZ).

**Naming convention:** `<script>--<routine>.md`, where `<script>` is the
script's basename (`install.sh`, `uninstall.sh`, `vigil-flow-jail-ctl.sh`,
`vigil-flow-supervisor.sh`, `vigil-flow-ctl.sh`) and `<routine>` is a function
definition in it. `vigil-flow-jail-ctl.sh` defines no
functions; its single routine, the whole-body flow, is documented as `main`.

Every routine file carries the same six sections: Purpose, Inputs and outputs,
Side effects, Failure modes and exit codes, Tests covering it, and Linked
decisions. Each was cross-checked against the script text quoted inside it.

The in-jail daemon scripts (`vigil-flow-supervisor.sh`, `vigil-flow-ctl.sh`)
landed with the sensor-daemon change and are documented below, the same way.
They run inside the jail — the supervisor via the jail's `exec.start`, the ctl
beside it — and the operator reaches both through `jexec` or the configd
actions; see [the sensor runbook](../opnsense-sensor.md) for those surfaces.

## install.sh — installer (26 routines)

Root-run, idempotent provisioner: validates flags, detects the FreeBSD ABI,
builds the jail userland, and writes every host fragment.

| Routine                                                                         | Role                                     |
| ------------------------------------------------------------------------------- | ---------------------------------------- |
| [`err`](install.sh--err.md)                                                     | Script-prefixed error line on stderr     |
| [`die`](install.sh--die.md)                                                     | Print a named cause and exit 1           |
| [`usage`](install.sh--usage.md)                                                 | Print installer help                     |
| [`is_valid_port`](install.sh--is_valid_port.md)                                 | Port is numeric and within 1-65535       |
| [`is_valid_ipv4`](install.sh--is_valid_ipv4.md)                                 | Dotted-quad IPv4 check                   |
| [`split_collector`](install.sh--split_collector.md)                             | Parse `HOST[:PORT]` into host and port   |
| [`validate_interfaces`](install.sh--validate_interfaces.md)                     | Syntax-only check of the interface list  |
| [`validate_netflow_version`](install.sh--validate_netflow_version.md)           | Accept only `9` or `ipfix`               |
| [`parse_args`](install.sh--parse_args.md)                                       | Parse CLI flags into config variables    |
| [`arch_from_uname`](install.sh--arch_from_uname.md)                             | `uname -m` to FreeBSD arch directory     |
| [`freebsd_release_from_userland`](install.sh--freebsd_release_from_userland.md) | Userland version to downloadable release |
| [`pkg_abi_for`](install.sh--pkg_abi_for.md)                                     | Release and arch to pkg ABI string       |
| [`base_txz_url`](install.sh--base_txz_url.md)                                   | Official base.txz download URL           |
| [`detect_abi`](install.sh--detect_abi.md)                                       | Detect userland, release, arch, ABI, URL |
| [`assert_interfaces_exist`](install.sh--assert_interfaces_exist.md)             | Runtime check on the host stack          |
| [`write_manifest`](install.sh--write_manifest.md)                               | Record everything the installer creates  |
| [`append_devfs_fragment`](install.sh--append_devfs_fragment.md)                 | Idempotent devfs ruleset append          |
| [`ensure_jail_conf_include`](install.sh--ensure_jail_conf_include.md)           | Idempotent `jail.conf` include directive |
| [`write_jail_conf`](install.sh--write_jail_conf.md)                             | Emit the jail fragment                   |
| [`write_sensor_config`](install.sh--write_sensor_config.md)                     | Emit the sensor configuration            |
| [`write_configd_action`](install.sh--write_configd_action.md)                   | Register `configctl` actions             |
| [`copy_host_wrapper`](install.sh--copy_host_wrapper.md)                         | Install the jexec wrapper                |
| [`fetch_base_txz`](install.sh--fetch_base_txz.md)                               | Fetch the matching base.txz              |
| [`extract_base_txz`](install.sh--extract_base_txz.md)                           | Untar the jail userland                  |
| [`install_softflowd`](install.sh--install_softflowd.md)                         | `pkg -r` softflowd into the jail         |
| [`main`](install.sh--main.md)                                                   | Orchestrate the whole install            |

## uninstall.sh — uninstaller (7 routines)

Manifest-driven clean removal of everything install.sh recorded.

| Routine                                                     | Role                                 |
| ----------------------------------------------------------- | ------------------------------------ |
| [`err`](uninstall.sh--err.md)                               | Script-prefixed error line on stderr |
| [`die`](uninstall.sh--die.md)                               | Print a named cause and exit 1       |
| [`usage`](uninstall.sh--usage.md)                           | Print uninstaller help               |
| [`stop_jail`](uninstall.sh--stop_jail.md)                   | `jail -r` the jail if running        |
| [`strip_marked_block`](uninstall.sh--strip_marked_block.md) | Delete a marked fragment block       |
| [`process_manifest`](uninstall.sh--process_manifest.md)     | Apply every manifest entry           |
| [`main`](uninstall.sh--main.md)                             | Orchestrate the removal              |

## vigil-flow-jail-ctl.sh — host wrapper (1 routine)

| Routine                                   | Role                                                  |
| ----------------------------------------- | ----------------------------------------------------- |
| [`main`](vigil-flow-jail-ctl.sh--main.md) | Forward `status\|reconfigure` into the jail via jexec |

## vigil-flow-supervisor.sh — in-jail supervisor (46 routines)

The daemon itself: loads and validates the sensor configuration, supervises
one `softflowd` child per capture interface, and rewrites the health JSON on
every state transition.

| Routine                                                                                       | Role                                       |
| --------------------------------------------------------------------------------------------- | ------------------------------------------ |
| [`err`](vigil-flow-supervisor.sh--err.md)                                                     | Script-prefixed error line on stderr       |
| [`die`](vigil-flow-supervisor.sh--die.md)                                                     | Print a named cause and exit 1             |
| [`usage`](vigil-flow-supervisor.sh--usage.md)                                                 | Print supervisor help                      |
| [`now_utc`](vigil-flow-supervisor.sh--now_utc.md)                                             | Current UTC time as ISO-8601 basic         |
| [`trim_ws`](vigil-flow-supervisor.sh--trim_ws.md)                                             | Strip surrounding whitespace               |
| [`json_string`](vigil-flow-supervisor.sh--json_string.md)                                     | JSON-encode a scalar (with C0 escapes)     |
| [`json_or_null`](vigil-flow-supervisor.sh--json_or_null.md)                                   | Value, or JSON null when empty             |
| [`json_iface_array`](vigil-flow-supervisor.sh--json_iface_array.md)                           | Interface list to a JSON array             |
| [`sanitize_detail`](vigil-flow-supervisor.sh--sanitize_detail.md)                             | Detail line safe for one JSON string line  |
| [`is_valid_port`](vigil-flow-supervisor.sh--is_valid_port.md)                                 | Port is numeric and within 1-65535         |
| [`is_int_in_range`](vigil-flow-supervisor.sh--is_int_in_range.md)                             | Integer within an inclusive range          |
| [`is_iface_list`](vigil-flow-supervisor.sh--is_iface_list.md)                                 | Interface-list syntax check                |
| [`load_config`](vigil-flow-supervisor.sh--load_config.md)                                     | Parse the `key = value` config file        |
| [`validate_loaded_config`](vigil-flow-supervisor.sh--validate_loaded_config.md)               | Range checks on loaded values              |
| [`find_openable_bpf`](vigil-flow-supervisor.sh--find_openable_bpf.md)                         | First openable `/dev/bpf*` device          |
| [`assert_bpf_available`](vigil-flow-supervisor.sh--assert_bpf_available.md)                   | Degrade unless bpf capture works           |
| [`capture_interfaces_exist`](vigil-flow-supervisor.sh--capture_interfaces_exist.md)           | Degrade unless capture ifaces exist        |
| [`assert_binaries_available`](vigil-flow-supervisor.sh--assert_binaries_available.md)         | Degrade unless softflowd/softflowctl exist |
| [`collector_is_resolvable`](vigil-flow-supervisor.sh--collector_is_resolvable.md)             | Advisory collector resolution check        |
| [`run_validation_gate`](vigil-flow-supervisor.sh--run_validation_gate.md)                     | Shared config + runtime validation gate    |
| [`build_softflowd_args`](vigil-flow-supervisor.sh--build_softflowd_args.md)                   | softflowd argv from validated config       |
| [`parse_flows_total`](vigil-flow-supervisor.sh--parse_flows_total.md)                         | Flows total from softflowctl stats output  |
| [`pidfile_for`](vigil-flow-supervisor.sh--pidfile_for.md)                                     | Per-interface pidfile path                 |
| [`ctlfile_for`](vigil-flow-supervisor.sh--ctlfile_for.md)                                     | Per-interface control socket path          |
| [`child_get`](vigil-flow-supervisor.sh--child_get.md)                                         | Look up a child's pid and state            |
| [`child_set`](vigil-flow-supervisor.sh--child_set.md)                                         | Update a child's state in the registry     |
| [`sum_registry_flows`](vigil-flow-supervisor.sh--sum_registry_flows.md)                       | Sum `flows_total` over the registry        |
| [`registry_all_alive`](vigil-flow-supervisor.sh--registry_all_alive.md)                       | Whether every child is still RUNNING       |
| [`set_state`](vigil-flow-supervisor.sh--set_state.md)                                         | Enter a state, stamp it, write health      |
| [`degrade`](vigil-flow-supervisor.sh--degrade.md)                                             | Enter DEGRADED with a named cause          |
| [`write_supervisor_pidfile`](vigil-flow-supervisor.sh--write_supervisor_pidfile.md)           | Write the supervisor pidfile               |
| [`write_health`](vigil-flow-supervisor.sh--write_health.md)                                   | Atomically rewrite the health JSON         |
| [`spawn_child`](vigil-flow-supervisor.sh--spawn_child.md)                                     | Start softflowd for one interface          |
| [`spawn_all_children`](vigil-flow-supervisor.sh--spawn_all_children.md)                       | Start softflowd for every interface        |
| [`stop_child`](vigil-flow-supervisor.sh--stop_child.md)                                       | Stop one child (SIGTERM, then SIGKILL)     |
| [`stop_all_children`](vigil-flow-supervisor.sh--stop_all_children.md)                         | Stop every child                           |
| [`restart_backoff_seconds`](vigil-flow-supervisor.sh--restart_backoff_seconds.md)             | Bounded exponential backoff                |
| [`supervise_children`](vigil-flow-supervisor.sh--supervise_children.md)                       | Reap dead children, restart within cap     |
| [`poll_stats`](vigil-flow-supervisor.sh--poll_stats.md)                                       | Poll `flows_total`, write health           |
| [`supervise_recover`](vigil-flow-supervisor.sh--supervise_recover.md)                         | Leave DEGRADED when checks pass again      |
| [`supervise_once`](vigil-flow-supervisor.sh--supervise_once.md)                               | One full supervision tick                  |
| [`graceful_stop`](vigil-flow-supervisor.sh--graceful_stop.md)                                 | Stop children, clean files, mark STOPPED   |
| [`mark_stopped_and_write_health`](vigil-flow-supervisor.sh--mark_stopped_and_write_health.md) | Final STOPPED health record                |
| [`run_supervisor`](vigil-flow-supervisor.sh--run_supervisor.md)                               | BOOT → VALIDATE → RUN entry point          |
| [`supervise_loop`](vigil-flow-supervisor.sh--supervise_loop.md)                               | Tick loop (the supervisor's top level)     |
| [`main`](vigil-flow-supervisor.sh--main.md)                                                   | Foreground entry with usage dispatch       |

## vigil-flow-ctl.sh — in-jail daemon control (13 routines)

The operator CLI inside the jail: `start`, `stop`, `status`, `validate` and
`reconfigure`, reached directly or through the host wrapper.

| Routine                                                                        | Role                                           |
| ------------------------------------------------------------------------------ | ---------------------------------------------- |
| [`err`](vigil-flow-ctl.sh--err.md)                                             | Script-prefixed error line on stderr           |
| [`die`](vigil-flow-ctl.sh--die.md)                                             | Print a named cause and exit 1                 |
| [`usage`](vigil-flow-ctl.sh--usage.md)                                         | Print ctl help                                 |
| [`load_supervisor_functions`](vigil-flow-ctl.sh--load_supervisor_functions.md) | Source the sibling supervisor's functions      |
| [`supervisor_running`](vigil-flow-ctl.sh--supervisor_running.md)               | Whether the supervisor pid is alive            |
| [`wait_for_supervisor_exit`](vigil-flow-ctl.sh--wait_for_supervisor_exit.md)   | Bounded wait for the supervisor to exit        |
| [`sweep_orphan_softflowd`](vigil-flow-ctl.sh--sweep_orphan_softflowd.md)       | Kill softflowd orphaned by a crash             |
| [`cmd_start`](vigil-flow-ctl.sh--cmd_start.md)                                 | Validate the config, then start the supervisor |
| [`cmd_stop`](vigil-flow-ctl.sh--cmd_stop.md)                                   | Stop the supervisor and sweep orphans          |
| [`cmd_status`](vigil-flow-ctl.sh--cmd_status.md)                               | Print the health JSON                          |
| [`cmd_validate`](vigil-flow-ctl.sh--cmd_validate.md)                           | Validate the config, print its summary         |
| [`cmd_reconfigure`](vigil-flow-ctl.sh--cmd_reconfigure.md)                     | Validate, then restart with the new config     |
| [`main`](vigil-flow-ctl.sh--main.md)                                           | Dispatch argv to the `cmd_*` routines          |

## Test coverage map

The hermetic bats suite (60 cases, no network, no host modification) lives in
`appliance/opnsense/tests/`:

- `installer.bats` (19 cases): flag parsing and rejections, IPv4 and ABI
  mapping, idempotent fragment handling, generated-file contracts.
- `fragments.bats` (4 cases): the shipped devfs, jail and config reference
  fragments match the documented contracts, and the wrapper forwards only
  `status` and `reconfigure`.
- `argbuilder.bats` (6 cases): the exact softflowd argv for fixture configs.
- `statemachine.bats` (12 cases): state transitions and the health JSON they
  write.
- `validator.bats` (19 cases): config and runtime prerequisite rejections.

Routines that need a real OPNsense host or the network (`detect_abi`,
`assert_interfaces_exist`, `fetch_base_txz`, `extract_base_txz`,
`install_softflowd`, `main` in both scaffold scripts, `stop_jail`,
`strip_marked_block`, `process_manifest`, `write_manifest`,
`write_configd_action`, `copy_host_wrapper`) have no direct bats case. The
daemon's live path — child spawn/stop, the supervision tick, stats polling —
runs only under a real softflowd and is exercised indirectly by the fixture
cases above plus the on-device runbook
([docs/opnsense-sensor.md](../opnsense-sensor.md)); each routine page says so
and names the check that covers it instead.
