# 0007 — Release branch strategy: feat/opnsense-netflow

- **Status:** Accepted
- **Date:** 2026-10-09
- **Source of truth:** component spec (art_4ou8t1mZ), section
  "Locked — architecture and integration", item 7, and its
  "Release-mode state (machine-read on resume)" block.

## Context

The spec's evidence on this repo's CI (Repository evidence table) shows every
PR already runs the TS `check` job plus `linux`/`macos.yml` integration jobs,
with path-gated jobs for bench/ai-escape/live-feeds — so a long-lived
integration branch keeps every child PR gated by the same tooling. The spec's
own release-mode block records the strategy as machine-readable state:

> "**releaseStrategy:** release · **releaseBranch:** `feat/opnsense-netflow`
> · **releasePrUrl:** [jvlatacc/Vigil-at-Home#1](https://github.com/jvlatacc/Vigil-at-Home/pull/1)
> (draft, targets `main`). Child PRs target the release branch; promotion
> happens when all children merge."

Observed this session (repo state, tool-verified): the branch exists on the
remote; the scaffold PR #2 merged into `feat/opnsense-netflow` as squash
commit `be84faa`; release PR #1 remains a draft targeting `main`.

## Decision

The spec's locked item 7, quoted in full:

> "**Branch strategy:** work lands on `feat/opnsense-netflow` (created from
> `main`, pushed this session); child PRs target it."

## Consequences

- All OPNsense sensor work — scaffold, this documentation, the daemon change,
  the runbook — stacks on `feat/opnsense-netflow`, keeping `main` free of
  half-assembled appliance state while the component grows.
- Promotion to `main` happens through the release PR once "all children
  merge" (spec, release-mode block); until then `main` carries no appliance
  code.
- Squash is this repo's merge method (`.obvious/config.yml` policy), which
  matched how the scaffold landed (PR #2 squash-merged as `be84faa`).
- This decision is documentation-strategy, not runtime: unlike 0001-0006 it
  changes no appliance behavior, and its deliverable is that work orders
  itself without the chat history.

## Alternatives considered

- **Straight to `main` per PR.** Rejected by the spec's release strategy:
  component work integrates on the release branch first, with one promotion
  merge.
- **A `release/*` branch name pattern.** Not carried by the spec: the locked
  decision names `feat/opnsense-netflow`, and the release PR (#1) targets
  `main` from it.

## Related decisions

- [0003 — appliance/ outside the pnpm workspace](0003-appliance-outside-pnpm-workspace.md)
  (what stays out of `main` until promotion)
- [0004 — POSIX sh runtime, shellcheck + bats CI](0004-posix-sh-runtime-shell-ci.md)
  (the gates every child PR runs)
