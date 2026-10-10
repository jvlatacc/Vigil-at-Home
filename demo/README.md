# Vigil-at-Home → Vigil SOC demo

One command proves the whole integration story: a local Vigil SOC (Docker),
deterministic Vigil-at-Home detections, and all three feeding paths — live
push, bulk ingest, MCP pull — each leaving observable findings and cases in
the SOC.

```bash
bash demo/scripts/run.sh          # leaves the SOC running afterwards
bash demo/scripts/run.sh --down   # also tears the SOC stack down at the end
```

## Prerequisites

- Node 22.13+ (`node:sqlite` — the MCP server and ingest CLI read the store directly)
- Docker with Compose (the Vigil SOC quick start runs in Docker)
- `pnpm install` already run in this repo

The first run builds the VigilSOC backend image — several minutes of pulls.
Later runs reuse everything under `demo/.run/`.

## What the run does

| Step | Script                      | What happens                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `scripts/soc-up.sh`         | Clones VigilSOC into `demo/.run/vigil-soc`, writes a local `.env` (`DEV_MODE=true`, a minted `JWT_SECRET_KEY` and `AGENT_INTERNAL_TOKEN` — unset, no workflow can run), `docker compose up -d`, then health-checks the API on :6987.                                                                                                                                                                                                  |
| 2    | `scripts/produce-alerts.ts` | A headless Vigil core — the app's own `VigilCore`/`Detector` pipeline, minus Electron — fires every canonical attack from `packages/bench`, and the shipped `SocForwarder` pushes each alert as a finding (`source: "vigil-at-home"`, `auto_cluster_cases: true`) and PATCHes one resolution through the frozen `/api/v1` update. The settings store is the real one: opt-in, key encrypted, transport `https`-or-localhost enforced. |
| 3    | `scripts/bulk-ingest.ts`    | Drives the shipped `soc-export` CLI as a subprocess: export the run's alerts to redacted JSONL, upload through the authenticated ingest router, then import a deliberate case linking two findings — the case construction auto-clustering cannot show.                                                                                                                                                                               |
| 4    | `scripts/mcp-pull.ts`       | Spawns the stdio MCP server exactly as a VigilSOC `mcp_config.json` would, lists its three read-only tools, calls them against the run's database, and queues one finding for the agent pipeline via `POST /api/findings/{id}/intake` (VS-11) — Triage and Investigator take it from there.                                                                                                                                           |
| 5    | `scripts/verify.ts`         | The acceptance gate. Exits non-zero unless push findings, ingest findings, the linked case, MCP tool answers, and the intake trigger are all observable in the SOC.                                                                                                                                                                                                                                                                   |

Watch it live while it runs: UI http://localhost:6988, API docs
http://localhost:6987/docs (local `DEV_MODE` bypasses auth — demo only).

## Where things land

`demo/.run/` is gitignored scratch: the VigilSOC clone, the demo SQLite
database (`state/vigil.db`), the redacted export (`state/bulk.jsonl`), and one
JSON state file per step (`state/*.json`) that `verify.ts` reads back.

`soc-down.sh` stops the stack; `--down` on `run.sh` chains it. Deleting
`demo/.run/` resets everything.

## Path 3 in Docker: the stdio constraint (spec OQ-2)

MCP over stdio means the consumer spawns the server as a child process. The
Dockerized VigilSOC backend therefore spawns MCP servers inside its own
container, where the host's checkout — and the demo database path — do not
exist. This harness verifies that at build time: after `scripts/soc-up.sh`
brings the containerized stack up, the backend container cannot see the host
server path or database. That resolves spec open question OQ-2:

- **Default (paths 1–2, and path 3's tool calls):** fully Dockerized SOC.
  The MCP pull path still runs — the demo driver plays the consumer, the
  same way the SOC's agent host would.
- **Fallback (path 3 as a native integration):** `scripts/soc-source-up.sh`
  runs VigilSOC's supported `./start.sh -d` — data stores stay in Docker, the
  API runs from source on the host — so the stdio server can be a genuine
  sibling process registered in `mcp_config.json`.

## Failures and what they mean

- `run.sh` exits 3 with a one-line reason when Docker is unreachable, Node is
  older than 22.13, or dependencies are missing — it never half-runs.
- The verification script names each check (`PASS`/`FAIL`) so a red run says
  exactly which path failed.
- The SOC stack logs land in the clone under `demo/.run/vigil-soc/`; compose
  state prints if the API never becomes healthy.
