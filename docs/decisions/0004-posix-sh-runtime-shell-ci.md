# 0004 — POSIX sh runtime, with the shellcheck + bats CI job

- **Status:** Accepted
- **Date:** 2026-10-09
- **Source of truth:** component spec (art_4ou8t1mZ), section
  "Locked — architecture and integration", item 4, plus its Repository
  evidence rows on CI and CONTRIBUTING.

## Context

The appliance runs on OPNsense, where Node.js does not exist. The spec's
Repository evidence adds two repo facts: every PR already runs a TS `check`
job, and — before this component — no workflow mentioned shellcheck, bats, or
actionlint even though the repo ships `helper/*.sh` ("shell linting is a
pre-existing gap"). The spec's conclusion: introduce the repo's first scoped
shell gate rather than inherit the gap, and do it in a dedicated job so the
existing TS jobs stay untouched.

The merged scaffold carries the runtime contract in code:

- every appliance script is POSIX `#!/bin/sh` with no dependencies beyond
  base-system tools and, inside the jail, `softflowd`/`softflowctl`;
- the testing contract: "when `VIGIL_FLOW_SKIP_MAIN` is set, sourcing this
  file only defines functions — the bats suite
  (appliance/opnsense/tests) exercises them hermetically by pointing the
  location variables below at a temp dir" (`install.sh` header);
- `.github/workflows/ci.yml` job `appliance` (ubuntu-latest):
  `shellcheck $(find appliance -type f -name '*.sh')` with zero findings,
  then `bats appliance/opnsense/tests`.

## Decision

The spec's locked item 4, quoted in full:

> "**Runtime is POSIX sh** — no Node.js on device. Unit tests are bats; lint
> is shellcheck; both run in a new, scope-limited `appliance` CI job. This is
> the documented exception to CONTRIBUTING's 'TypeScript only'."

## Consequences

- Every new shell file is covered by shellcheck — the spec allows "no
  exceptions, including the configd wrapper" (the wrapper therefore ships as
  a repo file and is copied into place, see
  [`copy_host_wrapper`](../routines/install.sh--copy_host_wrapper.md)).
- No test depends on network egress: "the bats suite runs hermetic with
  stubs" (spec). On this branch the suite is 23 hermetic cases across
  `installer.bats` and `fragments.bats`.
- CI proves lint, unit-level behavior of pure shell functions, fragment
  contracts, and that the TS repo is unaffected. Capture, export, and
  installer behavior on real hardware stay with the on-device runbook — see
  [data.md, verification matrix](../design/data.md).
- CONTRIBUTING.md's "TypeScript only" rule keeps its meaning for the pnpm
  workspace; `appliance/` is the documented exception, enforced by its own
  gate rather than by the TS one.

## Alternatives considered

- **A Node.js or TypeScript runtime on device.** Rejected: there is no
  Node.js on the appliance (spec, item 4) — that is the root constraint this
  decision starts from.
- **Extending the existing TS CI jobs with shell steps.** Rejected: the spec
  decides for a dedicated, scope-limited `appliance` job so the existing
  gates stay untouched (spec, Repository evidence on `.github/workflows`).
- **Python or another base-system scripting runtime.** Not carried by the
  spec: the locked decision names POSIX sh, and the scaffold's only
  interpreter line is `#!/bin/sh`.

## Related decisions

- [0003 — appliance/ outside the pnpm workspace](0003-appliance-outside-pnpm-workspace.md)
- [0005 — No PHP GUI in v1](0005-no-php-gui-configd-actions.md) (the wrapper
  and ctl scripts this gate covers)
