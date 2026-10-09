# vigil-flow design data

The numbers, schemas, and verification boundary behind the [decision
log](../decisions/README.md) — kept in the repo so the sensor's logic can be
replayed without the chat history that produced it. Quoted strings are from
the component spec ("OPNsense NetFlow Sensor — Vigil appliance component
spec", art_4ou8t1mZ); everything else is from the current branch's code
(scaffold squash commit `be84faa`).

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

The single source of truth is a POSIX `key = value` file
(`/var/db/vigil-flow/vigil-flow.conf` by default; `--config-file` relocates
it) that the installer writes from CLI flags. Written by
[`write_sensor_config`](../routines/install.sh--write_sensor_config.md);
parsed by the supervisor, which refuses to start an unvalidated config.

| Key                  | Default (installer)                                            | Validation at install time                 |
| -------------------- | -------------------------------------------------------------- | ------------------------------------------ |
| `capture_interfaces` | `--capture-interfaces` flag, required                          | non-empty; each name in host `ifconfig -l` |
| `collector_host`     | host part of `--collector` (required)                          | non-empty, no `[`/`]`                      |
| `collector_port`     | `2550` for a bare `--collector HOST`                           | integer 1-65535 (`is_valid_port`)          |
| `netflow_version`    | `9` (`--netflow-version`)                                      | `9` or `ipfix` only                        |
| `active_timeout`     | `300`                                                          | spec value, emitted fixed                  |
| `inactive_timeout`   | `30`                                                           | spec value, emitted fixed                  |
| `max_flows`          | `8192`                                                         | spec value, emitted fixed                  |
| `status_file`        | `/var/db/vigil-flow/status.json` (path joins `VIGIL_DATA_DIR`) | spec value                                 |

Generated-file sketch (installer output, with the flag values inline):

```sh
# vigil-flow sensor configuration
# Generated by install.sh; edit and run vigil-flow-ctl.sh validate.
capture_interfaces = "lan0"
collector_host = "192.0.2.10"
collector_port = "2550" # default per product decision
netflow_version = "9" # 9 | ipfix (maps to softflowd -v 9 | -v 10)
active_timeout = "300"
inactive_timeout = "30"
max_flows = "8192"
status_file = "/var/db/vigil-flow/status.json"
```

## Health-JSON schema

The supervisor's contract (spec): "the health file always tells the truth,
and a crash never leaves the jail silently dark." The file is rewritten "on
every transition and stats poll" at `status_file` (default
`/var/db/vigil-flow/status.json`).

| Field                          | Type                  | Meaning                                                                     |
| ------------------------------ | --------------------- | --------------------------------------------------------------------------- |
| `state`                        | string                | `BOOTING` / `RUNNING` / `RESTARTING` / `DEGRADED` — the state-machine state |
| `softflowd_pid`                | number                | PID of the supervised child while running                                   |
| `collector`                    | string                | `host:port` the config resolves to                                          |
| `export_version`               | string                | `9` or `ipfix` (as configured)                                              |
| `capture_interfaces`           | array                 | interface names being captured                                              |
| `flows_total`                  | number                | cumulative flow count from the last successful stats poll                   |
| `consecutive_restart_failures` | number                | restart-attempt counter; 0 while healthy                                    |
| `last_stats_poll`              | string (ISO 8601 UTC) | when stats were last read successfully                                      |
| `last_transition`              | string (ISO 8601 UTC) | when the state last changed                                                 |

Example (spec):

```json
{
  "state": "RUNNING",
  "softflowd_pid": 4182,
  "collector": "192.0.2.10:2550",
  "export_version": "9",
  "capture_interfaces": ["lan0"],
  "flows_total": 84123,
  "consecutive_restart_failures": 0,
  "last_stats_poll": "2026-10-09T17:31:00Z",
  "last_transition": "2026-10-09T17:29:55Z"
}
```

The supervisor and health file land with the daemon change; this schema is
the contract they implement.

## State machine

"The supervisor is a small state machine with one contract: the health file
always tells the truth, and a crash never leaves the jail silently dark"
(spec). Solid edges are autonomous; dashed edges are operator-driven
recovery; every transition rewrites the health JSON.

```text
BOOT ──config readable──> VALIDATE ──all checks pass──> RUNNING
  │                           │                             │
  └──missing/bad config──> DEGRADED <──first failure──────┘
                                ^                             │
                                │              child exit     │
                                ├──(retries exhausted)── RESTARTING
                                ^                             │
                                └──────── operator fixes cause,
                             `reconfigure` (dashed)───────────┘
```

| State      | Entry                                    | Exit                                         | Health file says                                    |
| ---------- | ---------------------------------------- | -------------------------------------------- | --------------------------------------------------- |
| BOOT       | Jail `exec.start`                        | Config file found and readable               | `state=BOOTING`                                     |
| VALIDATE   | Config readable                          | All checks pass, or first failure            | Failing check named on failure                      |
| RUNNING    | softflowd child alive after start        | Child exit, or jail stop                     | PID, collector, poll timestamps                     |
| RESTARTING | softflowd exited                         | Child alive again (backoff, bounded retries) | Failure counter incremented                         |
| DEGRADED   | Validation failure, or retries exhausted | Operator fixes cause and runs `reconfigure`  | Named cause (config / bpf missing / interface gone) |

Validation checks (VALIDATE, spec list):

- Config parses; every value in range (port 1-65535, version 9|ipfix,
  non-empty interface list).
- Each capture interface exists on the host stack (non-VNET jail shares it).
- At least one `/dev/bpf*` device is openable — otherwise capture cannot
  work.
- Collector host resolves and the route to it exists (a firewalled collector
  must not prevent capture from starting — the UDP send test is a stats-poll
  concern, not a startup blocker).

"The bpf check is the runbook's first stop: if the devfs ruleset was lost
(e.g. after an OPNsense firmware upgrade re-wrote `/etc/devfs.rules`), the
sensor must say _exactly_ that in its health file rather than run blind."
The supervisor is a spec sketch; the shipped `write_jail_conf` already wires
its `exec.start`/`exec.stop` to the ctl script, so the jail entry point is
live as soon as the daemon lands.

## Verification matrix

From the spec's observable-outcomes table, with the current branch's
evidence:

| Observable outcome                                                                                                           | How verified                                                                                                                                      | Failure looks like                           |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| All shell passes lint                                                                                                        | `appliance` CI job (ubuntu-latest): `shellcheck appliance/**/*.sh` with zero findings                                                             | PR red with SC codes                         |
| Arg builder emits the exact softflowd argv for a fixture config (v9 → `-v 9`, ipfix → `-v 10`, collector joined `host:port`) | `bats appliance/opnsense/tests` in the same job                                                                                                   | Red bats run with argv diff                  |
| Validator rejects bad configs: port out of 1-65535, unknown version, empty interface, missing file                           | bats cases per rejection (11 `parse_args` cases on this branch)                                                                                   | Red bats run                                 |
| State machine transitions write health JSON (RUNNING after start, counter grows on failure, DEGRADED names cause)            | bats over the state functions with a stubbed softflowd                                                                                            | Red bats run                                 |
| Jail/devfs fragments match the documented contract (ruleset id 5, `bpf*` unhide, non-VNET keys present)                      | bats assertions over the fragment files (4 `fragments.bats` cases on this branch)                                                                 | Red bats run                                 |
| Naming policy still passes repo-wide                                                                                         | Existing `check:naming` job (already scans all paths)                                                                                             | Existing check job red                       |
| TS gates untouched and green                                                                                                 | Existing `check`/`linux`/`macos.yml` jobs unchanged                                                                                               | Existing jobs red                            |
| On a real OPNsense box: bpf visible in jail, sensor RUNNING, collector receives v9 records                                   | Manual runbook: `jexec vigil-flow ls /dev/bpf0` → `vigil-flow-ctl.sh status` → `tcpdump -i any udp port 2550` on the collector host shows records | DEGRADED health file names the failing check |

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
