# OPNsense NetFlow Sensor (vigil-flow)

Jail-contained Vigil sensor for OPNsense firewalls: softflowd runs inside a
non-VNET FreeBSD jail, observes traffic on the configured host interfaces
through a deliberate `/dev/bpf*` devfs grant, and exports NetFlow v9 (or
IPFIX) over UDP to an off-device collector (default port 2550).

Component spec: blueprint "OPNsense NetFlow Sensor — Vigil appliance
component spec" (art_4ou8t1mZ). The on-device runbook is
`docs/opnsense-sensor.md`.

This directory is deliberately **not** a pnpm workspace member: the appliance
runs POSIX sh where Node.js does not exist. That makes it the documented
exception to the "TypeScript only" rule in CONTRIBUTING.md — CI enforces the
same discipline with shellcheck and bats instead (the `appliance` job in
`.github/workflows/ci.yml`).

## Layout

| Path                             | Purpose                                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `install.sh`                     | Root-run, idempotent installer: jail userland, devfs ruleset, jail conf, sensor config, configd actions |
| `uninstall.sh`                   | Manifest-driven clean removal of everything install.sh created                                          |
| `jail/devfs.rules`               | Reference devfs fragment (`[devfsrules_vigil_flow=5]`, `bpf*` unhide)                                   |
| `jail/vigil-flow.conf`           | Reference jail conf (non-VNET, `mount.devfs`, `persist`)                                                |
| `share/vigil-flow.conf`          | Sensor config template (exact spec keys)                                                                |
| `share/vigil-flow-supervisor.sh` | The in-jail daemon: validation gate, per-interface softflowd supervision, health JSON                   |
| `share/vigil-flow-ctl.sh`        | In-jail operator control: `start\|stop\|status\|validate\|reconfigure`                                  |
| `share/vigil-flow-jail-ctl.sh`   | Thin jexec host wrapper behind `configctl vigil-flow status\|reconfigure`                               |
| `tests/`                         | Hermetic bats tests (no network, no host modification)                                                  |

## Install (run as root on the OPNsense host)

Copy `appliance/opnsense/` to the firewall, then:

```sh
sh install.sh --interfaces lan0 --collector 192.0.2.10:2550 --ip 192.0.2.254
```

| Flag           | Meaning                                    | Default            |
| -------------- | ------------------------------------------ | ------------------ |
| `--interfaces` | Comma-separated host interfaces to capture | required           |
| `--collector`  | NetFlow collector as `HOST[:PORT]`         | port defaults 2550 |
| `--ip`         | IPv4 address assigned to the jail          | required           |
| `--version`    | `9` or `ipfix`                             | `9`                |

What the installer creates (all recorded in
`/var/vigil-flow/install-manifest.txt` for uninstall):

- `/etc/devfs.rules` fragment: `[devfsrules_vigil_flow=5]` with
  `add path 'bpf*' unhide`, inside marked `# >>> vigil-flow >>>` blocks —
  re-runs never duplicate it.
- The `.include "/etc/jail.conf.d/*.conf";` directive in `/etc/jail.conf`:
  jail(8) reads `jail.conf.d` only through that explicit include.
- `/etc/jail.conf.d/vigil-flow.conf`: non-VNET jail on ruleset 5,
  `mount.devfs`, `persist`, the `--ip` address.
- The FreeBSD base userland (matching `freebsd-version -u` ABI, fetched from
  the official FreeBSD release server) plus `softflowd`, both inside
  `/var/vigil-flow/jail` — `pkg -r` with the jail ABI override; nothing is
  installed on the host.
- `<jail>/etc/vigil-flow.conf`: the sensor configuration (exact spec keys,
  flags substituted).
- `/usr/local/opnsense/service/conf/actions.d/actions_vigil-flow.conf` plus
  `/usr/local/bin/vigil-flow-jail-ctl.sh`: `configctl vigil-flow
status|reconfigure`.

Failures are loud and name their cause: non-OPNsense host, non-RELEASE
userland ABI, unsupported architecture, invalid flags, missing capture
interface, fetch or pkg failures.

## Uninstall

```sh
sh uninstall.sh
```

Stops the jail, strips the marked devfs and jail.conf blocks, deletes the
recorded files, and removes the jail tree and manifest.

## Status

The scaffold (PR #2) and the in-jail daemon (PR #29) are both shipped: the
daemon scripts are `share/vigil-flow-ctl.sh` + `share/vigil-flow-supervisor.sh`,
and `exec.start` runs the ctl, which starts and supervises the sensor on jail
boot. The installer provisions the jail and the host integration; it does not
copy the daemon scripts into the jail — the runbook's finish-the-install step
does that by hand.

## Verification boundary

CI (ubuntu-latest) proves: shellcheck with zero findings, bats contract tests
(fragment contracts, flag parsing and rejections, generated-file contracts,
idempotency), and that nothing in the TypeScript workspace is touched.
GitHub-hosted runners cannot run FreeBSD, so capture and export behavior must
be verified on a real appliance with the runbook:
`jexec vigil-flow ls /dev/bpf0` → `configctl vigil-flow status` →
`tcpdump -i any udp port 2550` on the collector host.
