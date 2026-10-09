# 0003 — appliance/ lives outside the pnpm workspace

- **Status:** Accepted
- **Date:** 2026-10-09
- **Source of truth:** component spec (art_4ou8t1mZ), section
  "Locked — architecture and integration", item 3, plus its Repository
  evidence table.

## Context

The spec's Repository evidence table records how this repo's tooling is wired
(observed in `package.json`, `pnpm-workspace.yaml`, `.github/workflows/ci.yml`,
`scripts/check-naming.mjs`, `CONTRIBUTING.md`):

- workspace globs are `apps/*` + `packages/*`; root `pnpm check` =
  `check:naming` + eslint/prettier + `pnpm -r typecheck` + root vitest run;
- `scripts/check-naming.mjs` scans **all** tracked files and paths for a
  banned-former-name regex — language-agnostic;
- CONTRIBUTING.md line 20: "TypeScript only. One pnpm workspace: apps in
  `apps/`, libraries in `packages/`."

The appliance runtime is POSIX sh where Node.js does not exist, so the
workspace's TypeScript gates must never touch it — while the language-agnostic
checks must still apply. The scaffold sits accordingly: `appliance/` is a new
top-level directory, and `pnpm-workspace.yaml` still globs only `apps/*` and
`packages/*`. The CI job's own comment states the intent: "appliance/ is
deliberately not a pnpm workspace member."

## Decision

The spec's locked item 3, quoted in full:

> "**Home: `appliance/opnsense/`**, a new top-level directory that is not a
> pnpm workspace member (keeps root `pnpm -r typecheck` and root vitest
> untouched; `check-naming` still scans it)."

## Consequences

- Root `pnpm -r typecheck` and the root vitest run never see `appliance/`;
  the existing `check`, `linux`, and `macos.yml` gates stay untouched.
- `check-naming` still scans every appliance path — it is language-agnostic —
  and CI verifies that (`scripts/check-naming.mjs` runs repo-wide).
- Prettier still applies: `pnpm lint` runs `prettier --check .`, so the
  appliance Markdown (including `appliance/opnsense/README.md`) must stay
  format-clean. The spec calls this out: "Prettier-checked markdown inside
  `appliance/` must stay format-clean."
- Shell discipline needs its own gate, which is the next decision
  ([0004](0004-posix-sh-runtime-shell-ci.md)).

## Alternatives considered

- **A workspace member with a no-op typecheck.** Rejected: it would drag
  root's Node-based gates over a no-Node runtime and blur the "TypeScript
  only" boundary the repo documents in CONTRIBUTING.md.
- **A separate repository.** Rejected: the spec treats the sensor as a
  component of this repo ("a greenfield sibling deliverable, not an Electron
  app extension"), and the shared repo keeps check-naming and prettier
  applying to it.

## Related decisions

- [0004 — POSIX sh runtime, shellcheck + bats CI](0004-posix-sh-runtime-shell-ci.md)
- Naming and docs conventions surface in every routine reference under
  [docs/routines/](../routines/README.md).
