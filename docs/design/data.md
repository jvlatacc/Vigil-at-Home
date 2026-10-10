# vigil-flow design data

The numbers, schemas, and verification boundary behind the [decision
log](../decisions/README.md) — kept in the repo so the sensor's logic can be
replayed without the chat history that produced it. Quoted strings are from
the component spec ("OPNsense NetFlow Sensor — Vigil appliance component
spec", art_4ou8t1mZ); everything else is from the current branch's shipped
code (scaffold PR #2, `be84faa`; sensor daemon PR #29, `073c29e`; runbook and
routine reference PR #38, `9889e8e`). Where the shipped scripts and the spec
draft disagree, the script is authoritative and the routine that implements a
corrected fact is cited.

## Evidence tables

### Repository evidence (observed this session, tool-verified)

| Evidence                                           | What it showed                                                                                                                                                                         | Decision it shaped                                                                                                                                                   |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `README.md`                                        | Vigil at Home is a desktop SOC (Santa/fapolicyd/osquery sensors, deterministic rules, helper-based blocking). No appliance, network, or flow story exists.                             | The OPNsense sensor is a greenfield sibling deliverable, not an Electron app extension.                                                                              |
| `package.json`, `pnpm-workspace.yaml`              | Workspace globs are `apps/*` + `packages/*`; root `pnpm check` = `check:naming` + eslint/prettier + `pnpm -r typecheck` + root vitest run.                                             | The appliance component must live _outside_ the workspace globs so root TS tooling never touches it. → [0003](../decisions/0003-appliance-outside-pnpm-workspace.md) |
| `.github/workflows/ci.yml`, `macos.yml`            | Every PR runs a `check` job (naming, lint, typecheck, test, desktop build) and a `linux` integration job; `macos.yml` also runs on all PRs; bench/ai-escape/live-feeds are path-gated. | Add a dedicated `appliance` CI job (shellcheck + bats, ubuntu-latest) rather than extending TS jobs. → [0004](../decisions/0004-posix-sh-runtime-shell-ci.md)        |
| `scripts/check-naming.mjs`                         | Scans _all_ tracked files and paths for a banned-former-name regex; language-agnostic.                                                                                                 | Component and file naming in `appliance/` must pass the same scan — verified in CI.                                                                                  |
| `packages/helper` install scripts                  | Shell already ships in this repo (4 tracked `helper/*.sh`), but no workflow mentioned shellcheck/bats/actionlint — shell linting is a pre-existing gap.                                | The appliance component introduces the repo's first scoped shell gate instead of inheriting the gap. → [0004](../decisions/0004-posix-sh-runtime-shell-ci.md)        |
| `CONTRIBUTING.md`                                  | "TypeScript only" for the pnpm workspace; `pnpm check` is the project-wide gate; no root `AGENTS.md`.                                                                                  | The appliance runtime is a documented, deliberate exception: it must run where Node.js does not exist. → [0004](../decisions/0004-posix-sh-runtime-shell-ci.md)      |
| Repo grep for `netflow\|softflowd\|opnsense\|jail` | Zero implementation hits (pcap: one test fixture; bsd: license tables only).                                                                                                           | No existing patterns to conflict with; nothing to migrate.                                                                                                           |

### Platform evidence (spec's web research, this session)

| Evidence                                                                                                                                | What it showed                                                                                                                                                                                                         | Decision it shaped                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OPNsense development/backend documentation — docs.opnsense.org/development/backend.html, backend/configd.html, examples/helloworld.html | Third-party daemons ship as FreeBSD pkg + configd actions under `/usr/local/opnsense/service/conf/actions.d/` + rc.d service; back-ends go through configd, never direct `config.xml` edits.                           | Host integration is a configd action file + a thin host wrapper around `jexec`; no PHP plugin in v1. → [0005](../decisions/0005-no-php-gui-configd-actions.md)       |
| OPNsense Reporting/NetFlow documentation                                                                                                | OPNsense's native export is `softflowd` (Reporting → NetFlow): chosen interfaces, collector host/port, versions v5/v9/IPFIX over UDP.                                                                                  | softflowd is the proven exporter for this platform; the jail reuses it rather than writing a flow engine. → [0002](../decisions/0002-netflow-v9-udp-port-2550.md)    |
| FreeBSD jails handbook — docs.freebsd.org/en/books/handbook/jails/, `jail(8)`                                                           | Default jail devfs ruleset hides `bpf`; a custom ruleset (`add path 'bpf*' unhide`) exposes it. Non-VNET jails share the host network stack; VNET jails see only their own interfaces; `ng_netflow` is host-side only. | The "all in the jail" design is feasible only as a _non-VNET_ jail with a deliberate devfs grant. → [0001](../decisions/0001-jail-contained-capture-non-vnet-bpf.md) |

The spec's warning, verbatim: "A jail cannot sniff host-routed traffic 'for
free' — the research was explicit. Every claim of jail-contained capture in
this spec depends on the unhidden `bpf*` grant, and the verification runbook
checks it first."

## Sensor configuration keys

The single source of truth is a POSIX `key = "value"` file the installer
writes inside the jail root: `/var/vigil-flow/jail/etc/vigil-flow.conf` on the
host — `/etc/vigil-flow.conf` from inside the jail, which is the supervisor's
default `VIGIL_FLOW_CONFIG` (written by
[`write_sensor_config`](../routines/install.sh--write_sensor_config.md);
parsed by [`load_config`](../routines/vigil-flow-supervisor.sh--load_config.md),
cross-checked by
[`validate_loaded_config`](../routines/vigil-flow-supervisor.sh--validate_loaded_config.md)).
The supervisor refuses to start an unvalidated config: the ctl `start` runs
the gate first and writes DEGRADED + exits 1 on failure
([`cmd_start`](../routines/vigil-flow-ctl.sh--cmd_start.md)), and
`run_supervisor` re-runs it before spawning any child. `--config-file PATH`
is a supervisor/ctl CLI override ([`main`](../routines/vigil-flow-supervisor.sh--main.md),
[`main`](../routines/vigil-flow-ctl.sh--main.md)), not an installer flag.

The installer flags ([`usage`](../routines/install.sh--usage.md) /
[`parse_args`](../routines/install.sh--parse_args.md)): `--interfaces
IFACE[,IFACE...]` (required), `--collector HOST[:PORT]` (required; port
defaults to 2550), `--ip ADDRESS` (required, dotted-quad IPv4), `--version
9|ipfix` (default `9`), and `-h/--help`. `--ip` feeds the jail fragment
([`write_jail_conf`](../routines/install.sh--write_jail_conf.md)), not the
sensor config.

| Key                  | Default (installer)                           | Install-time validation                                                                                                    |
| -------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `capture_interfaces` | `--interfaces` flag, required                 | non-empty names of `[A-Za-z0-9._-]` (`validate_interfaces`); each exists in host `ifconfig -l` (`assert_interfaces_exist`) |
| `collector_host`     | host part of `--collector` (required)         | non-empty; IPv6 literals rejected in v1 (`split_collector`)                                                                |
| `collector_port`     | `2550` for a bare `--collector HOST`          | integer 1-65535 (`is_valid_port`, via `split_collector`)                                                                   |
| `netflow_version`    | `9` (`--version`)                             | `9` or `ipfix` only (`validate_netflow_version`)                                                                           |
| `active_timeout`     | `300`, emitted fixed (`write_sensor_config`)  | runtime range 1-604800 seconds (`load_config`)                                                                             |
| `inactive_timeout`   | `30`, emitted fixed (`write_sensor_config`)   | runtime range 1-604800 seconds (`load_config`)                                                                             |
| `max_flows`          | `8192`, emitted fixed (`write_sensor_config`) | runtime range 1-1048576 (`load_config`)                                                                                    |
| `status_file`        | `/var/db/vigil-flow/status.json`              | absolute path, charset `[A-Za-z0-9/._-]` (`load_config`)                                                                   |

The installer output, verbatim from the
[`write_sensor_config`](../routines/install.sh--write_sensor_config.md)
heredoc (example flag values inline):

```sh
# vigil-flow sensor configuration (installed by appliance/opnsense/install.sh)

# Capture on these host interfaces, seen through unhidden /dev/bpf*.
capture_interfaces = "lan0"

# Off-device NetFlow collector.
collector_host = "192.0.2.10"
collector_port = "2550"

# 9 | ipfix (maps to softflowd -v 9 | -v 10)
netflow_version = "9"

# Flow timeouts and limits (passed to softflowd -t / -m).
active_timeout = "300"
inactive_timeout = "30"
max_flows = "8192"

# Health/status output (JSON, rewritten on every transition and stats poll).
status_file = "/var/db/vigil-flow/status.json"
```

## Health-JSON schema

The supervisor's contract (spec): "the health file always tells the truth,
and a crash never leaves the jail silently dark." The file is rewritten at
`status_file` — the config key, defaulting to `/var/db/vigil-flow/status.json`
(`VIGIL_FLOW_STATUS_FILE`; `load_config` overrides the default from the key) —
on every state transition (`set_state` calls `write_health`) and on every
supervision tick (`supervise_once` ends in `write_health`), including the
ctl-side records written before or after a supervisor runs
(`cmd_start`/`cmd_stop` via `degrade` and `mark_stopped_and_write_health`).
Writes are atomic — temp file plus rename — so a reader never sees a partial
file.

The schema below is what [`write_health`](../routines/vigil-flow-supervisor.sh--write_health.md)
emits, field for field. The supervisor runs one softflowd child per
configured capture interface
([`spawn_all_children`](../routines/vigil-flow-supervisor.sh--spawn_all_children.md)),
each with its own pidfile and control socket
([`pidfile_for`](../routines/vigil-flow-supervisor.sh--pidfile_for.md),
[`ctlfile_for`](../routines/vigil-flow-supervisor.sh--ctlfile_for.md)).

| Field                          | Type                            | Meaning                                                                                              |
| ------------------------------ | ------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `state`                        | string                          | `BOOTING` / `VALIDATE` / `RUNNING` / `RESTARTING` / `DEGRADED` / `STOPPED` — the state-machine state |
| `softflowd_pid`                | number or `null`                | the first registered child's PID; `null` when no child is registered                                 |
| `softflowd_pids`               | object                          | per-interface pid map (`"lan0": 4182`); shipped extension for multi-interface capture                |
| `collector`                    | string or `null`                | `host:port` the config resolves to; `null` before a config is loaded                                 |
| `export_version`               | string or `null`                | `9` or `ipfix` (as configured); `null` before a config is loaded                                     |
| `capture_interfaces`           | array                           | interface names being captured                                                                       |
| `flows_total`                  | number                          | sum of per-child flow counters (`sum_registry_flows`), refreshed by `poll_stats`                     |
| `consecutive_restart_failures` | number                          | restart-attempt counter; reset to 0 when every child is alive again                                  |
| `degraded_cause`               | string                          | named cause while DEGRADED, `""` otherwise; sanitized via `sanitize_detail` — shipped extension      |
| `last_stats_poll`              | string (ISO 8601 UTC) or `null` | when stats were last read successfully (`poll_stats`); `null` before the first success               |
| `last_transition`              | string (ISO 8601 UTC) or `null` | when the state last changed (`set_state`)                                                            |

Example (the RUNNING record from the runbook's verification step 3; `flows_total` grows and `last_stats_poll` advances while traffic flows):

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

A DEGRADED record carries the cause in `degraded_cause`, e.g.
`"bpf_missing: no openable /dev/bpf* device (is the [devfsrules_vigil_flow]
grant in /etc/devfs.rules?)"`. The daemon shipped in PR #29 (`073c29e`);
`write_health` is the schema's implementation.

## State machine

"The supervisor is a small state machine with one contract: the health file
always tells the truth, and a crash never leaves the jail silently dark"
(spec). Every transition rewrites the health JSON; in the shipped machine the
DEGRADED recovery edge is autonomous (each tick re-runs the gate), with
`reconfigure` as the operator-driven path through the same gate.

```text
BOOTING ──config found and readable──> VALIDATE ──gate passes, children spawn──> RUNNING
   │                                     │                                           │
   │ missing/unreadable config           │ first gate failure               child exit│
   v                                     v                                           v
 DEGRADED <──────────────────────────────┴──────────────────────────────────── RESTARTING
   ^  ^                             (bounded retries: backoff, then bound exhausted)
   │  └── recovery is automatic: every DEGRADED tick re-runs the gate
   │      (supervise_recover); reconfigure runs the same gate and restarts
   └── entered on: first gate failure, restart bound exhausted
       (restart_exhausted), or a lost prerequisite at a tick

 RUNNING ──SIGTERM (jail exec.stop / ctl stop)──> STOPPED (final health record)
```

Shipped states (`set_state` values; the state machine and the recovery edges
live in `run_supervisor`, `supervise_children`, `supervise_recover`, and
`graceful_stop`):

| State        | Entry                                                                                                                                                                        | Exit                                                                                                                 | Health file says                                    |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `BOOTING`    | Supervisor start (jail `exec.start` → ctl `start` → `run_supervisor`)                                                                                                        | Config file found and readable; missing/unreadable goes straight to DEGRADED (`config_missing:`)                     | `state=BOOTING`                                     |
| `VALIDATE`   | Config readable                                                                                                                                                              | Full gate passes and children spawn, or first failure → DEGRADED                                                     | Failing check named in `degraded_cause` on failure  |
| `RUNNING`    | Children alive after `spawn_all_children`                                                                                                                                    | Child exit → RESTARTING; lost bpf/interface/binary → DEGRADED; SIGTERM → STOPPED                                     | PID(s), collector, poll timestamps                  |
| `RESTARTING` | A child died                                                                                                                                                                 | Children alive again → RUNNING (counter resets), or bound exhausted → DEGRADED                                       | Failure counter incremented, backoff between starts |
| `DEGRADED`   | Validation failure, exhausted restarts, or lost prerequisite                                                                                                                 | Automatic: each tick re-runs the gate (`supervise_recover`) → RUNNING; `reconfigure` runs the same gate and restarts | Named cause in `degraded_cause`                     |
| `STOPPED`    | Graceful stop (SIGTERM via jail `exec.stop` or ctl `stop`) — final `softflowctl shutdown` export attempt, then the record (`graceful_stop`, `mark_stopped_and_write_health`) | Terminal until the next `start`                                                                                      | `state=STOPPED`, no children, no cause              |

Restarts are bounded: a dead child restarts with exponential backoff
(`restart_backoff_seconds`, 1/2/4/… seconds capped at
`VIGIL_FLOW_MAX_BACKOFF` = 60) until its attempt count exceeds
`VIGIL_FLOW_MAX_CONSEC_RESTARTS` = 5 — then DEGRADED names
`restart_exhausted:`. Runtime ticks re-check the prerequisites
(`supervise_once`: bpf, interfaces, binaries) so a lost grant degrades the
sensor instead of leaving it running blind.

Validation checks (VALIDATE, the shipped
[`run_validation_gate`](../routines/vigil-flow-supervisor.sh--run_validation_gate.md),
in order):

- [`load_config`](../routines/vigil-flow-supervisor.sh--load_config.md) — the
  file exists and is readable, then grammar and per-key checks: `key =
"quoted value"`, bare-identifier keys, no duplicates, port 1-65535, version
  `9`|`ipfix`, non-empty `[A-Za-z0-9._-]` interface list, timeouts 1-604800
  seconds, `max_flows` 1-1048576, absolute `status_file` path.
- [`validate_loaded_config`](../routines/vigil-flow-supervisor.sh--validate_loaded_config.md)
  — every required key present.
- [`assert_binaries_available`](../routines/vigil-flow-supervisor.sh--assert_binaries_available.md)
  — `softflowd` and `softflowctl` are executable inside the jail.
- [`capture_interfaces_exist`](../routines/vigil-flow-supervisor.sh--capture_interfaces_exist.md)
  — each interface exists on the host stack (`ifconfig -l`; the non-VNET jail
  shares it).
- [`assert_bpf_available`](../routines/vigil-flow-supervisor.sh--assert_bpf_available.md)
  — at least one `/dev/bpf*` device is openable
  ([`find_openable_bpf`](../routines/vigil-flow-supervisor.sh--find_openable_bpf.md));
  otherwise capture cannot work.

Collector resolvability is **not** part of the gate:
[`collector_is_resolvable`](../routines/vigil-flow-supervisor.sh--collector_is_resolvable.md)
is advisory only — `cmd_validate` prints a note and never fails — so a
firewalled or unresolvable collector cannot prevent capture from starting.
Export failures surface in the stats poll instead: a per-interface poll
failure keeps that interface's last known count and `last_stats_poll` goes
stale ([`poll_stats`](../routines/vigil-flow-supervisor.sh--poll_stats.md)).

"The bpf check is the runbook's first stop: if the devfs ruleset was lost
(e.g. after an OPNsense firmware upgrade re-wrote `/etc/devfs.rules`), the
sensor must say _exactly_ that in its health file rather than run blind."
The daemon shipped in PR #29 (`073c29e`): the jail's `exec.start`/`exec.stop`
(`write_jail_conf`) run the ctl, which starts and gracefully stops the
supervisor.

## Verification matrix

From the spec's observable-outcomes table, with the current branch's
evidence:

| Observable outcome                                                                                                                                                     | How verified                                                                                                                                                                      | Failure looks like                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| All shell passes lint                                                                                                                                                  | `appliance` CI job (ubuntu-latest): `shellcheck $(find appliance -type f -name '*.sh')` with zero findings                                                                        | PR red with SC codes                         |
| Arg builder emits the exact softflowd argv for a fixture config (v9 → `-v 9`, ipfix → `-v 10`, collector joined `host:port`, per-child `-p` pidfile / `-c` ctl socket) | `bats appliance/opnsense/tests` in the same job                                                                                                                                   | Red bats run with argv diff                  |
| Validator rejects bad configs: port out of 1-65535, unknown version, empty interface, missing file                                                                     | bats cases per rejection — `validator.bats`, 19 cases (60 hermetic cases in all on this branch)                                                                                   | Red bats run                                 |
| State machine transitions write health JSON (RUNNING after start, counter grows on failure, DEGRADED names cause, stop leaves STOPPED)                                 | `statemachine.bats`, 12 cases over the state functions with a stubbed softflowd                                                                                                   | Red bats run                                 |
| Jail/devfs fragments match the documented contract (ruleset id 5, `bpf*` unhide, non-VNET keys present)                                                                | `fragments.bats` assertions over the fragment files (4 cases)                                                                                                                     | Red bats run                                 |
| Naming policy still passes repo-wide                                                                                                                                   | Existing `check:naming` job (already scans all paths)                                                                                                                             | Existing check job red                       |
| TS gates untouched and green                                                                                                                                           | Existing `check`/`linux`/`macos.yml` jobs unchanged                                                                                                                               | Existing jobs red                            |
| On a real OPNsense box: bpf visible in jail, sensor RUNNING, collector receives v9 records                                                                             | Manual runbook: `jexec vigil-flow ls /dev/bpf0` → `jexec vigil-flow /usr/local/bin/vigil-flow-ctl.sh status` → `tcpdump -i any udp port 2550` on the collector host shows records | DEGRADED health file names the failing check |

### Known verification limits

> "**Honest CI boundary:** GitHub-hosted ubuntu runners cannot run FreeBSD,
> so CI cannot execute the jail, softflowd, or the install script against a
> real host. CI proves: lint, unit-level behavior of pure shell functions,
> fragment contracts, and that the TS repo is unaffected. Capture, export,
> and installer behavior are proven by the on-device runbook and must be
> re-run after any change to installer or fragments. (A FreeBSD VM runner
> via a third-party action is a future option, deliberately out of scope.)"

Two spec invariants round it out: "Every new shell file is covered by
shellcheck — no exceptions, including the configd wrapper", and "No test
depends on network egress; the bats suite runs hermetic with stubs."

## Risks

From the spec's risk table:

| Risk                                                                                    | Handling                                                                                                                                              |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| The devfs grant is a real privilege: a jail that can read packets                       | Jail runs no listeners beyond the ctl socket; grant is one named ruleset, auditable in `/etc/devfs.rules`; runbook calls it out; uninstall removes it |
| FreeBSD/OPNsense version drift (base.txz ABI, port names like `lan0` vs legacy drivers) | Installer detects versions, fails loudly on mismatch, accepts explicit interface names; supported-version matrix documented                           |
| OPNsense firmware upgrades can rewrite host `/etc` fragments                            | Installer is idempotent and re-runnable; health file surfaces lost-bpf state; runbook includes post-upgrade re-check                                  |
| Capture on LAN includes LAN↔LAN flows, which some operators won't expect                | Documented explicitly; WAN-interface capture is the strict-LAN→WAN alternative                                                                        |
