# OPNsense NetFlow sensor (vigil-flow)

Vigil's sensor for OPNsense firewalls. A non-VNET FreeBSD jail on the firewall
runs `softflowd` to watch traffic on the configured interfaces and export
NetFlow v9 over UDP to an off-device collector (default port **2550**; `ipfix`
is a config value, not a separate mode). A shell supervisor inside the jail
keeps the exporter alive, re-checks its prerequisites on every tick, and
rewrites a JSON health file on every transition so the sensor never goes
silently dark. The host gains no packages and no daemon: one installer, one
jail, two configd actions.

The design and its history live in
[the decision log](decisions/README.md) (0001–0007), the numbers and schemas
in [design data](design/data.md), and every routine of every script in the
[routine reference](routines/README.md). This page is the operator's copy:
what to run, what it prints, and what to check when it isn't working.

## Install (run as root on the OPNsense firewall)

Copy `appliance/opnsense/` somewhere on the firewall (the examples below use
`/root/vigil-flow`), then run the installer:

```sh
cd /root/vigil-flow/appliance/opnsense
sh install.sh --interfaces lan0 --collector 192.0.2.10:2550 --ip 192.0.2.254
```

| Flag           | Meaning                                                  | Default                          |
| -------------- | -------------------------------------------------------- | -------------------------------- |
| `--interfaces` | Comma-separated host interfaces to capture               | required                         |
| `--collector`  | Off-device collector as `HOST[:PORT]`                    | port defaults to **2550**        |
| `--ip`         | IPv4 address assigned to the jail (rides the host stack) | required                         |
| `--version`    | NetFlow export version                                   | `9` (`ipfix` is the alternative) |

The installer is idempotent — re-runs refresh the generated files and never
duplicate fragments — and every failure names its cause: a non-OPNsense host,
a non-RELEASE userland ABI, an unsupported architecture, invalid flags, a
missing capture interface, a failed fetch or `pkg` run.

A successful run provisions the jail userland (the matching FreeBSD `base.txz`
plus `softflowd` via `pkg -r`, both inside `/var/vigil-flow/jail`), appends the
marked `[devfsrules_vigil_flow=5]` ruleset to `/etc/devfs.rules`, adds the
`jail.conf.d` include, writes the jail fragment and the sensor configuration,
registers the configd actions, and installs the host wrapper. It ends with:

```text
install.sh: done. Next steps:
  1. service configd restart   # pick up the vigil-flow actions
  2. install the vigil-flow daemon scripts (sensor component), then:
  3. service jail start vigil-flow && configctl vigil-flow status
```

Finish the install by hand (the installer provisions; it does not copy the
daemon scripts):

```sh
service configd restart
cp /root/vigil-flow/appliance/opnsense/share/vigil-flow-ctl.sh \
   /root/vigil-flow/appliance/opnsense/share/vigil-flow-supervisor.sh \
   /var/vigil-flow/jail/usr/local/bin/
chmod 0755 /var/vigil-flow/jail/usr/local/bin/vigil-flow-ctl.sh \
           /var/vigil-flow/jail/usr/local/bin/vigil-flow-supervisor.sh
service jail start vigil-flow
```

The two scripts must sit in the same directory (the ctl finds the supervisor
next to itself), and the ctl needs the executable bit because the jail's
`exec.start` runs it directly.

## Sensor configuration

One file, inside the jail: `/var/vigil-flow/jail/etc/vigil-flow.conf`, written
by the installer from the flags. Edit it, then `validate` and `reconfigure`
(below) — no service restart needed for config changes.

| Key                  | Installer default                     | Accepted values                              |
| -------------------- | ------------------------------------- | -------------------------------------------- |
| `capture_interfaces` | `--interfaces` (required)             | comma list; names in `[A-Za-z0-9._-]`        |
| `collector_host`     | host part of `--collector` (required) | hostname or IPv4                             |
| `collector_port`     | `2550` for a bare `--collector HOST`  | integer 1–65535                              |
| `netflow_version`    | `9`                                   | `9` or `ipfix` (`ipfix` → softflowd `-v 10`) |
| `active_timeout`     | `300`                                 | integer 1–604800 seconds                     |
| `inactive_timeout`   | `30`                                  | integer 1–604800 seconds                     |
| `max_flows`          | `8192`                                | integer 1–1048576                            |
| `status_file`        | `/var/db/vigil-flow/status.json`      | absolute path                                |

The values are also the validator's rules: out-of-range ports, unknown
versions, empty interface lists, unknown or duplicate keys, and unquoted
values are all rejected with named causes (see `load_config` in the routine
reference).

## Operator commands

Inside the jail — which for an operator on the host means through `jexec`:

```sh
jexec vigil-flow /usr/local/bin/vigil-flow-ctl.sh start        # validate, then run the supervisor
jexec vigil-flow /usr/local/bin/vigil-flow-ctl.sh stop         # graceful stop, final export attempt
jexec vigil-flow /usr/local/bin/vigil-flow-ctl.sh status       # print the health JSON
jexec vigil-flow /usr/local/bin/vigil-flow-ctl.sh validate     # validate the config, change nothing
jexec vigil-flow /usr/local/bin/vigil-flow-ctl.sh reconfigure  # validate, then restart with the new config
```

Each takes an optional `--config-file PATH` override. Exit codes: `0`
success, `1` the operation failed (a failed validation, a failed start), `2`
usage error. `start` is idempotent while the sensor runs; `stop` on a stopped
sensor still writes the STOPPED record and succeeds.

The OPNsense way — after `service configd restart`, the two registered
actions work from the host shell (or the GUI's configctl equivalent):

```sh
configctl vigil-flow status        # prints the health JSON (script_output action)
configctl vigil-flow reconfigure   # validate + restart with the current config
```

These go through the thin host wrapper (`/usr/local/bin/vigil-flow-jail-ctl.sh`),
which forwards only `status` and `reconfigure` into the jail via `jexec` —
there is no other host-side control path, and nothing on the host to update
when the config changes.

## Verification runbook (on a real appliance)

CI cannot run FreeBSD, so capture and export are proven here, on the box.
Run these in order; each one's expected output is concrete enough to diff
against reality.

**1. The bpf grant is intact inside the jail.** This is the first stop always
— every capture claim depends on it:

```sh
jexec vigil-flow ls /dev/bpf0
```

Expected: `/dev/bpf0` (exit 0). When this prints
`ls: /dev/bpf0: No such file or directory`, the devfs grant is gone — see
[after a firmware upgrade](#after-a-firmware-upgrade).

**2. The configuration passes the gate:**

```sh
jexec vigil-flow /usr/local/bin/vigil-flow-ctl.sh validate
```

Expected:

```text
vigil-flow: configuration valid
  capture_interfaces = lan0
  collector          = 192.0.2.10:2550
  export_version     = 9
  status_file        = /var/db/vigil-flow/status.json
```

A rejection prints the named cause and exits 1, e.g.
`config_invalid: collector_port '25500' is outside 1-65535`. A collector host
that does not resolve right now is a note, not a failure — capture must not
depend on the collector.

**3. The sensor is RUNNING, from its own health file:**

```sh
jexec vigil-flow /usr/local/bin/vigil-flow-ctl.sh status
```

Expected (fields per [design data](design/data.md); `softflowd_pids` and
`degraded_cause` are shipped extensions; `degraded_cause` is empty while
healthy):

```json
{
  "state": "RUNNING",
  "softflowd_pid": 4182,
  "softflowd_pids": { "lan0": 4182 },
  "collector": "192.0.2.10:2550",
  "export_version": "9",
  "capture_interfaces": ["lan0"],
  "flows_total": 84123,
  "consecutive_restart_failures": 0,
  "degraded_cause": "",
  "last_stats_poll": "2026-10-09T17:31:00Z",
  "last_transition": "2026-10-09T17:29:55Z"
}
```

`flows_total` grows as traffic flows; `last_stats_poll` advances. The state
names its own trouble when something breaks — a DEGRADED record carries the
cause, e.g. `"degraded_cause": "bpf_missing: no openable /dev/bpf* device (is
the [devfsrules_vigil_flow] grant in /etc/devfs.rules?)"`. A stopped sensor
has no status file yet: the command says so and exits 1.

**4. The collector is receiving the export.** On the collector host (here
`192.0.2.10`), watch the wire:

```sh
tcpdump -i any udp port 2550
```

Expected: a stream of UDP packets from the firewall to port 2550 whenever
traffic crosses the captured interface — one datagram per exported flow
template/record set. Nothing here while `status` says RUNNING means the
collector is firewalled off or the capture interface is quiet; the health
file's stale `last_stats_poll` is the tell.

**5. Config changes take effect without a jail restart:**

```sh
jexec vigil-flow /usr/local/bin/vigil-flow-ctl.sh reconfigure
```

Expected: `vigil-flow: started (supervisor pid N)` with a fresh pid — the
config was validated and the supervisor restarted with it. An invalid edit
leaves the running sensor untouched and exits 1 with the cause.

## After a firmware upgrade

OPNsense upgrades can rewrite host `/etc` — including `/etc/devfs.rules` —
and change the FreeBSD userland the jail must match. Re-run the installer; it
is idempotent and re-adds anything the upgrade removed:

```sh
sh install.sh --interfaces lan0 --collector 192.0.2.10:2550 --ip 192.0.2.254
service jail restart vigil-flow
```

Then re-run the [verification runbook](#verification-runbook-on-a-real-appliance)
from step 1. Two cases worth distinguishing:

- **The grant was lost** (health says `bpf_missing`): re-running the installer
  re-appends the ruleset fragment; that is the whole fix.
- **The userland ABI changed** (e.g. a major FreeBSD version bump): the
  installer detects the new ABI but deliberately keeps the existing jail tree,
  so re-source the jail userland by rebuilding it:

  ```sh
  sh uninstall.sh && sh install.sh --interfaces lan0 --collector 192.0.2.10:2550 --ip 192.0.2.254
  ```

  then re-copy the daemon scripts (the uninstall removes the jail tree that
  held them) and verify again.

## Uninstall

```sh
cd /root/vigil-flow/appliance/opnsense
sh uninstall.sh
```

Stops the jail, strips the marked devfs and `jail.conf` blocks, deletes the
recorded files (configd actions, host wrapper), and removes
`/var/vigil-flow` — exactly what the installer's manifest recorded, nothing
else. The manifest is written before the first host change, so an uninstall
after a failed install still removes only what exists.

## Capture choice: LAN or WAN interface

The sensor reports what the configured tap sees; it does not filter by
direction (that is the collector's job).

- **LAN interface capture** sees every conversation the router routes —
  including LAN-to-LAN traffic between two local hosts, which some operators
  do not expect to be exported.
- **WAN interface capture** sees strictly internet-bound traffic, at the cost
  of blind spots for local-only conversations.

Choose deliberately at install time (`--interfaces`) or later via
`reconfigure` after editing `capture_interfaces` in the config file.

## A note on the bpf grant

The design's one real privilege: the jail can read packets from the host's
network interfaces through unhidden `/dev/bpf*` devices — that is how a jail
taps routed traffic at all, and it is the reason the verification runbook
checks the grant first. The grant is contained and auditable:

- It is a single named ruleset, `[devfsrules_vigil_flow=5]`, in
  `/etc/devfs.rules` between `# >>> vigil-flow >>>` markers — visible in the
  file, removed by `uninstall.sh`.
- The jail shares the host network stack but runs no listeners: softflowd
  only sends UDP to the collector, and the ctl socket is a unix socket inside
  the jail.
- The jail userland is the official FreeBSD `base.txz` plus `softflowd` from
  the official FreeBSD package repository — nothing else is installed, and
  nothing is installed on the host itself.
- A compromised jail can observe traffic and write inside its own tree; it
  does not gain host root, and it cannot change the ruleset that governs it.

## Verification boundary

CI (the `appliance` job) proves shellcheck cleanliness, the 60-case hermetic
bats suite, and that nothing in the TypeScript workspace is touched — see the
[verification matrix](design/data.md) for the full picture. Capture, export,
and installer behavior on real hardware are proven by the runbook above, and
must be re-run after any change to the installer, the fragments, or the
daemon scripts.
