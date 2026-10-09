# 0001 — Capture runs entirely inside the jail

- **Status:** Accepted
- **Date:** 2026-10-09
- **Source of truth:** component spec "OPNsense NetFlow Sensor — Vigil
  appliance component spec" (art_4ou8t1mZ), section
  "Locked — product decisions", item 1.

## Context

The spec's research established what a FreeBSD jail can and cannot see. From
the spec's Platform evidence table (sources: the FreeBSD jails handbook at
docs.freebsd.org/en/books/handbook/jails/ and `jail(8)`):

- the default jail devfs ruleset hides `bpf`; a custom ruleset
  (`add path 'bpf*' unhide`) exposes it;
- non-VNET jails share the host network stack; VNET jails see only their own
  interfaces;
- `ng_netflow` is host-side only.

The spec draws the conclusion that shapes this whole component:

> "A jail cannot sniff host-routed traffic 'for free' — the research was
> explicit. Every claim of jail-contained capture in this spec depends on the
> unhidden `bpf*` grant, and the verification runbook checks it first."

The merged scaffold implements the grant and the jail it feeds:

- `appliance/opnsense/jail/devfs.rules` — reference fragment with the marked
  block `[devfsrules_vigil_flow=5]`, `add include $devfsrules_jail`,
  `add path 'bpf*' unhide`;
- `appliance/opnsense/jail/vigil-flow.conf` — non-VNET jail on ruleset 5,
  `mount.devfs`, `persist`, sharing the host stack;
- `install.sh` — `append_devfs_fragment` (idempotent, marker-delimited),
  `ensure_jail_conf_include`, `write_jail_conf`, `assert_interfaces_exist`
  (host `ifconfig -l` is authoritative because the jail shares the stack).

## Decision

The spec's locked item 1, quoted in full:

> "**Capture runs entirely inside the jail.** A single non-VNET BSD jail runs
> softflowd plus all Vigil tooling; packet observation is granted by exposing
> `/dev/bpf*` through a dedicated devfs ruleset. Host softflowd (OPNsense
> Reporting → NetFlow) is a documented fallback for operators, not something
> we ship or maintain."

## Consequences

- The host gains exactly one deliberate privilege grant, auditable in
  `/etc/devfs.rules` inside `# >>> vigil-flow >>>` markers, and
  `uninstall.sh` strips it again (`strip_marked_block` via the manifest). The
  spec's risk table carries the flip side: a jail that can read packets is a
  real privilege, so the jail runs no listeners beyond the ctl socket.
- If the grant is lost — the spec's risk table names OPNsense firmware
  upgrades rewriting `/etc/devfs.rules` — the sensor must not run blind: the
  supervisor's health file names the missing-bpf cause (see
  [data.md, state machine](../design/data.md)), and re-running the installer
  re-appends the fragment.
- Capture interface existence is checked on the host at install time
  (`assert_interfaces_exist`) because a non-VNET jail shares the host stack —
  there is no separate jail interface list to be wrong about.
- Capture on the LAN interface includes LAN↔LAN flows; the spec documents
  WAN-interface capture as the strict-LAN→WAN alternative (spec, "LAN→WAN
  focus").

## Alternatives considered

- **Host softflowd via OPNsense Reporting → NetFlow.** The proven exporter
  path (spec, Platform evidence), kept as a documented fallback for
  operators — but not shipped or maintained by this component, because the
  product decision is jail-contained capture.
- **VNET jail.** Rejected: a VNET jail sees only its own interfaces, so it
  cannot observe host-routed traffic at all (spec, Platform evidence).
- **`ng_netflow`.** Rejected: host-side only, which would put capture back on
  the host and defeat the containment this decision buys.

## Related decisions

- [0005 — No PHP GUI in v1](0005-no-php-gui-configd-actions.md) — how the
  host reaches into the jail (`configctl` → wrapper → `jexec`).
- [0006 — Jail userland from base.txz](0006-jail-userland-base-txz-softflowd.md)
  — what the jail runs.
- Routine references: [`append_devfs_fragment`](../routines/install.sh--append_devfs_fragment.md),
  [`write_jail_conf`](../routines/install.sh--write_jail_conf.md),
  [`assert_interfaces_exist`](../routines/install.sh--assert_interfaces_exist.md).
