# Decision log

Architecture and product decisions for the OPNsense vigil-flow sensor, one
ADR-style page per locked decision from the
[component spec](https://app.obvious.ai/p/prj_UrJtH8rQ?blueprint=art_4ou8t1mZ).
Every page carries Status, Context (the evidence with sources), Decision
(the spec text, quoted), Consequences, and Alternatives considered.

| #                                                   | Decision                                                                  | Status   |
| --------------------------------------------------- | ------------------------------------------------------------------------- | -------- |
| [0001](0001-jail-contained-capture-non-vnet-bpf.md) | Capture runs entirely inside the jail — non-VNET jail, `bpf*` devfs grant | Accepted |
| [0002](0002-netflow-v9-udp-port-2550.md)            | NetFlow v9 over UDP, collector port 2550, `ipfix` as a config value       | Accepted |
| [0003](0003-appliance-outside-pnpm-workspace.md)    | `appliance/` lives outside the pnpm workspace                             | Accepted |
| [0004](0004-posix-sh-runtime-shell-ci.md)           | POSIX sh runtime, shellcheck + bats CI job                                | Accepted |
| [0005](0005-no-php-gui-configd-actions.md)          | No PHP GUI in v1 — configd actions plus the ctl surface                   | Accepted |
| [0006](0006-jail-userland-base-txz-softflowd.md)    | Jail userland from base.txz, softflowd via `pkg -r`, zero host packages   | Accepted |
| [0007](0007-release-branch-strategy.md)             | Release branch strategy: `feat/opnsense-netflow`                          | Accepted |

Companion material:

- [Design data](../design/data.md) — evidence tables, config keys,
  health-JSON schema, state machine, verification matrix.
- [Routine reference](../routines/README.md) — one page per routine in the
  appliance shell scripts, each linked to the decisions above.
