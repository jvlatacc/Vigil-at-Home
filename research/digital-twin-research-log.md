# Digital Twin — Feature Research & Step Log

**Repo:** `jvlatacc/Vigil-at-Home` · **Commit inspected:** `67ba6fc914d517477d3c972c169f93c4052e2ebc` (main, merge of PR #170, 2026-10-09)
**Feature:** a digital twin — a live in-app view showing the machine's processes and network maps in relation to each other (process ↔ connection ↔ remote endpoint / listening port)
**Recorded:** 2026-10-09 · **Thread:** [`th_zBl7R7ra`](https://app.obvious.ai/p/vigil-at-home-digital-twin-ycb1002D?thread=th_zBl7R7ra) · **Root task:** `todo_1UlpqO49`
**Method note:** every claim below was produced this session and cites either a `file:line` read at the commit above (full citation detail lives in the two findings artifacts, Appendix A) or an artifact id.

---

## 1. The request

> "Create a digital twin feature in vigil-at-home that shows processes and network maps in their relation to each other."

Working interpretation: an interactive, live view of current system state — running processes joined to their open network connections, listening ports, and remote endpoints — rendered as a related graph, built into the Vigil desktop app.

---

## 2. Step log

| #   | When (UTC) | Step                                                                                                                                                                                                                                                   | Result                                                                                                                                                                                                                                                                |
| --- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 17:55      | Request received in thread `th_zBl7R7ra` (project `prj_ycb1002D`). Orientation pass: workspace-wide search + project inventory.                                                                                                                        | This project had **zero** existing artifacts/tasks — fresh feature thread.                                                                                                                                                                                            |
| 2   | 17:55      | Prior-work recovery: workspace search surfaced three sibling-project research artifacts about this same repo. Read **"Vigil Linux implementation map"** (`art_IkQSYZL6`, 3,396 words) in full.                                                         | Established before any dispatch: Electron app + root helper architecture, osquery sensor wiring, transport (NDJSON over `/run/vigil-helper.sock`), CI/test layout. Also noted: "NetFlow emission findings" (`art_jlOYR7Fc`) and "Security Findings" (`art_NKyO8wBc`). |
| 3   | 17:55      | Direct repo inspection on the shared repo sandbox (`cmp_fBk8IVvp`).                                                                                                                                                                                    | Confirmed: pnpm monorepo; `apps/desktop/src/{main,preload,renderer,shared}`; `packages/{agent-hook,ai,bench,core,detection,helper,sensors}`; root scripts (`check:naming`, `lint`, `typecheck`, `test`, `check`); node ≥ 22.12, pnpm 10.33.                           |
| 4   | 17:55:57   | Created two **read-only** research tasks under root `todo_1UlpqO49`; dispatched 17:56 as parallel coder workers, each in its own independent sandbox pinned to commit `67ba6fc`: data layer + IPC (`todo_9sC8v9IJ`) and renderer/UI (`todo_iJS99vKK`). | Both workers ran read-only (no edits, no branches, no PRs, app not run).                                                                                                                                                                                              |
| 5   | 18:01      | UI research published **`art_1ZTVjSQA`**; read in full by the orchestrator; task closed 18:02.                                                                                                                                                         | Renderer/UI fully mapped — §3 below.                                                                                                                                                                                                                                  |
| 6   | 18:03      | Data-layer research published **`art_pcK3zuwe`** (26.7k chars, retrievability verified after a republish); read in full by the orchestrator; task closed 18:04.                                                                                        | Data path fully mapped, with a 10-item gap list — §4 below. One correction to the research brief: the log-tail converter is `packages/sensors/src/tail.ts`, not `packages/helper/src/tail.ts` (does not exist).                                                       |
| 7   | 18:05      | This step log written and committed to the public repo under `research/`.                                                                                                                                                                              | This file.                                                                                                                                                                                                                                                            |

---

## 3. Findings A — renderer/UI layer (`art_1ZTVjSQA`)

**Stack and architecture**

- React 19, no state library; built with electron-vite 5 on Vite 8; entry `apps/desktop/src/renderer/index.html` → `main.tsx`. CSP allows no remote origins — everything bundles from npm into `out/`.
- Three surfaces share one `index.html` via URL hash: tray popover (380×540 fixed), detection popup (420×400), and the **main window (1180×760, resizable)** — the only surface with room for a graph.
- Hash routing: `Route` zod regex `/^[a-z]+(\/[A-Za-z0-9_-]+)?$/` (`shared/ipc.ts:78`) — **`twin` and `twin/<pid>` deep links are already valid routes.** Navigation = `NAV` + collapsible `ADVANCED_NAV` arrays in `AppShell.tsx:37-54`; new entries automatically get ⌘-shortcuts.

**Data flow pattern to follow (traced end-to-end via the Activity view)**

- Pull: `useLive(load, key)` → `window.vigil.<call>` (118 zod-validated IPC calls; main parses args with `calls[name].parse` after a sender-frame check).
- Push: main broadcasts on 7 channels (`changed, popup, navigate, theme, events, agents, pack`); the `events` push carries **only a count, at most 1 Hz** — the renderer responds by re-pulling. Push/pull lists are pinned by a compile-time `channelsMatch` check.

**Visualization precedent — none exists**

- **Zero graph/chart/canvas libraries** in any workspace package.json (grepped for d3/react-flow/cytoscape/sigma/three/etc.); no `<canvas>` in the renderer.
- House idiom: hand-rolled SVG driven by pure geometry modules — `views/UsageChart.tsx` (239-line SVG chart, monotone-cubic paths from scratch, helpers tested in `usage-format.ts`) — plus `components/ProcessTree.tsx` (DOM process list, `MAX_NODES = 200` cap with a visible "showing the first N" notice).

**Conventions that shape the build**

- `scripts/check-naming.mjs` fails on `dt_`/`dt-` identifiers — the feature must be named `twin`/`digital-twin` in code.
- Prettier 100 cols, single quotes; strict tsconfig with `exactOptionalPropertyTypes`; plain CSS via `styles/tokens.css` custom properties (dark default) + `components/ui.tsx` primitives (`Card`, `Chip`, `StatusMark`, `Segmented`); `lucide-react` icons; accessibility is a hard convention (roving keyboard nav, sr-only, aria attributes).
- Tests: vitest `.test.ts` only — **no component tests**; view logic goes in pure sibling modules (`live.test.ts`, `activity-rows.test.ts`, `usage-format.test.ts` are the pattern). E2E: Playwright `_electron.launch` against a built app (`popup.e2e.mjs`, `agents.e2e.mjs`, `flow.e2e.mjs`), runnable under `xvfb-run`.

---

## 4. Findings B — data layer + IPC (`art_pcK3zuwe`)

**What telemetry exists**

- `SensorEvent` zod union in `packages/core/src/event.ts:176-201`. Twin-relevant kinds: `process.exec` / `process.exit` (rich `ProcessRef`: pid + optional `startTime` ("pid + startTime identifies it; pids are reused"), path, args, uid/user, sha256, signing, quarantine origin, agent tag — `common.ts:66-113`), `network.connection` (direction/protocol/local/remote addr+port, optional `process` — `event.ts:44-56`), `network.listen` (`event.ts:100-107`).
- Sources: osquery via the root helper — `vigil_process_events` (bpf, 5 s interval), `vigil_network_connections` (`process_open_sockets JOIN processes`, 30 s), `vigil_listening_ports` (60 s) — `packages/sensors/src/osquery/linuxConfig.ts:90-116`. Plus `NetworkBurst` (2 s per-pid probes for risky launches — `burst.ts`).
- Pipeline: `FileTailer` (`sensors/src/tail.ts`) → `SensorHub` parse/enrich/dedupe (`hub.ts`) → helper socket (`events.subscribe`, 2,000-event replay buffer — `server.ts:23`) → app `HelperLink` (dedupe window 4,000 — `helper.ts:36`) → `VigilCore.handleEvent` → detection (`Detector.handle`) → SQLite.
- Storage: **`node:sqlite`** (no better-sqlite3/drizzle anywhere), full zod record as JSON `body` ("The JSON is the source of truth" — `schema.ts:4-7`), `events` table with `(kind, ts)` indexes, `EventLog` batched writes (500/1 s), retention 30 days + 1 GiB cap (`service.ts:72,78`).

**The load-bearing fact: telemetry is add-only event history, not state**

- osquery logs **differentially** ("only rows that were added or removed since the previous run" — `osquery/config.ts:5-11`), and Vigil **drops "removed" rows** (`resultParser.ts:81`): connections that close are never retracted; listeners that stop are never removed; loopback listeners are filtered out in SQL.
- Connection events are **hard-coded `direction: 'outbound'`** (`resultParser.ts:86`); `inbound` exists in the schema but nothing produces it.
- Live process state is **not** exposed: `/proc`/`ps` readers (`agents/ps.ts:27-95`) only seed the agent tracker at ≤30 s cadence; `osqueryd.snapshots.log` (full snapshot stream) is explicitly unread (`osquery/config.ts:113-117`); nothing joins a connection's pid back to its `process.exec` row, and pid-only joins are ambiguous across pid reuse.
- Verdict context is already available per event: `EventOutcome {checked, matches}` (rule mode `shadow|alert|block`), AI labels (`benign|unusual|suspicious`), signing/quarantine/hash on every `ProcessRef`, threat-list and verdict tables.

**Gap list (what the twin needs that does not exist today — 10 items)**

1. A maintained current-state model (no reducer over process/connection events exists).
2. Periodic full connection snapshots (options: read `osqueryd.snapshots.log`, or timer-driven one-off `OsqueryRunner` queries like `burstQuery`).
3. Connection/listener teardown events (no event kind represents close/stop).
4. A live process-table feed to the renderer (readers exist; never exposed via IPC).
5. A push channel or pull call carrying real state payloads (all 7 pushes carry counts/status only).
6. Loopback listening ports (filtered today; dev servers would be invisible).
7. Per-process network aggregation (no query or API groups endpoints by pid).
8. Reliable event→process join across pid reuse (connection `ProcessRef` omits `startTime`).
9. Endpoint enrichment (`remoteHost` never set; no DNS/GeoIP step).
10. Inbound direction (schema-supported, unproduced).

---

## 5. What this means for the twin (design direction — not yet locked)

These are the research-backed implications the spec must settle; nothing here is final until the Blueprint spec is approved:

- **Placement:** new `twin` entry in `ADVANCED_NAV` of the main window (the only surface with room); `Route` regex already accepts `twin` / `twin/<pid>`.
- **Rendering:** dependency-free SVG graph driven by a pure layout module (the `UsageChart.tsx` idiom) — no new graph library, which would inflate the bundle against CSP/bundling constraints.
- **State:** the twin needs a main-process current-state model (reducer over stored `process.exec`/`exit`/`network.*` events and/or a periodic snapshot probe) — the single biggest new piece, because today's telemetry is add-only event history.
- **IPC:** new zod-typed pull (e.g. twin-state snapshot) + its own push cadence, added across `shared/channels.ts`, `shared/ipc.ts`, `main/ipc.ts`, preload — following the `channelsMatch` pattern.
- **Node/edge caps and accessibility** are mandatory patterns to carry (`ProcessTree`'s 200-node cap; the repo's a11y conventions).
- **Naming:** `twin`/`digital-twin` everywhere; never `dt_`/`dt-` (`check-naming.mjs`).

---

## 6. Current state and next steps

- **Done:** research phase (both findings artifacts verified and closed; root task's research subtasks complete).
- **Next:** author the Blueprint spec with verifiable acceptance criteria → propose the execution plan (task DAG) → **user approval gate** → implementation PRs.
- **No code changes exist yet.** The repo was inspected read-only at commit `67ba6fc` throughout.

---

## Appendix A — Artifacts produced this effort

| Artifact       | Content                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------- |
| `art_IkQSYZL6` | Vigil Linux implementation map (sibling project "Vigil At Home Validation"; read for orientation) |
| `art_1ZTVjSQA` | Digital twin renderer/UI findings — full file:line citations                                      |
| `art_pcK3zuwe` | Digital twin data-layer + IPC findings — full file:line citations, 10-item gap list               |
| this file      | Step log (committed to the repo under `research/`)                                                |

## Appendix B — Conventions and traps discovered

- `scripts/check-naming.mjs` bans `--dt-`/`dt_` prefixes — do **not** abbreviate "digital twin" to `dt`.
- Renderer tests are pure-module only (`.test.ts`); JSX is never rendered in unit tests.
- `exactOptionalPropertyTypes` forces spread-idiom for optional props; `verbatimModuleSyntax` forces `import type`.
- Push channels must be added to both `PUSH_NAMES` (`shared/channels.ts`) and the typed `Pushes` map (`shared/ipc.ts`) — the `channelsMatch` compile-time check enforces sync.
- The tray popover (380×540, non-resizable) cannot host the graph; main window only.
