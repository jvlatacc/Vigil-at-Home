# 0005 — No PHP GUI in v1: configd actions plus the ctl surface

- **Status:** Accepted
- **Date:** 2026-10-09
- **Source of truth:** component spec (art_4ou8t1mZ), section
  "Locked — architecture and integration", item 5, plus its Platform
  evidence row on OPNsense backend/configd.

## Context

The spec's Platform evidence table records how OPNsense integrates
third-party daemons (sources: docs.opnsense.org/development/backend.html,
backend/configd.html, examples/helloworld.html):

> "Third-party daemons ship as FreeBSD pkg + configd actions under
> `/usr/local/opnsense/service/conf/actions.d/` + rc.d service; back-ends go
> through configd, never direct `config.xml` edits."

The conclusion the spec draws: "Host integration is a configd action file +
a thin host wrapper around `jexec`; no PHP plugin in v1."

The merged scaffold ships exactly that surface:

- `install.sh` — `write_configd_action` generates
  `/usr/local/opnsense/service/conf/actions.d/actions_vigil-flow.conf` with
  `status` and `reconfigure` commands, both pointing at
  `/usr/local/bin/vigil-flow-jail-ctl.sh`;
- `share/vigil-flow-jail-ctl.sh` — the thin wrapper: `exec jexec vigil-flow
/usr/local/bin/vigil-flow-ctl.sh "$1"` after validating the action word
  (usage + exit 2 otherwise);
- `write_sensor_config` — flags at install time; the spec adds
  `vigil-flow-ctl.sh reconfigure` as the operator's runtime path.

## Decision

The spec's locked item 5, quoted in full:

> "**No PHP GUI in v1.** Operator surface = installer flags + config file +
> `vigil-flow-ctl.sh` + two host configd actions (`status`, `reconfigure`)."

## Consequences

- Operators get `configctl vigil-flow status` and
  `configctl vigil-flow reconfigure` after `service configd restart` (the
  installer's next-steps list), without any GUI work.
- The spec notes the configd action is "a thin `jexec` wrapper, per
  OPNsense's configd conventions" — "so operators (and a future GUI) get"
  the actions; the GUI is therefore a future extension, not a dead end.
- The config file remains the single source of truth; the wrapper forwards
  only the two action words, and everything else is shell + file editing.
- The wrapper is shellcheck-covered like every other shell file
  ([0004](0004-posix-sh-runtime-shell-ci.md)).

## Alternatives considered

- **A PHP plugin with GUI pages.** Rejected for v1: the spec locks "no PHP
  GUI in v1" and keeps a future GUI possible via the configd actions.
- **Direct `config.xml` edits from the scripts.** Rejected: the platform
  evidence says back-ends go through configd, never direct `config.xml`
  edits.
- **rc.d service on the host.** The platform evidence mentions rc.d as the
  general daemon shape, but this component's runtime lives in the jail; the
  jail itself is managed by `jail.conf.d` + `service jail`, so no host rc.d
  script ships in the scaffold.

## Related decisions

- [0001 — Capture runs entirely inside the jail](0001-jail-contained-capture-non-vnet-bpf.md)
  (why the host surface is a wrapper, not a daemon)
- [0002 — NetFlow v9 over UDP](0002-netflow-v9-udp-port-2550.md) (what the
  actions control)
- Routine references: [`write_configd_action`](../routines/install.sh--write_configd_action.md),
  [`vigil-flow-jail-ctl.sh`](../routines/vigil-flow-jail-ctl.sh--main.md).
