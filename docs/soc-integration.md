# Feeding Vigil SOC from Vigil-at-Home

Vigil-at-Home is local-first: sensors feed deterministic rules, alerts land in
a local SQLite database, and nothing about the user leaves the machine unless
the user asks. Vigil SOC is where those alerts can then be investigated by AI
agents. This document describes the bridge: what crosses, how it is mapped,
and how to turn each path on.

The ground rules, non-negotiable:

- **Export is opt-in and off by default.** Until the user enables SOC export
  in Settings and fills in an endpoint, no SOC-bound network call exists.
- **Redaction runs before egress.** Every payload passes the same in-repo
  redactor (`@vigil/ai`'s `redactValue`/`redactAndSerialize`) that the
  copy-as-JSON evidence export uses: per-token `<redacted>`, whole-field
  `[withheld: may contain a secret]`, byte caps, and oversized fields
  withheld unread.
- **No raw sensor logs cross.** Findings are derived from alerts — not
  event dumps.

## The three paths

| Path        | Direction | Transport                                                            | Creates                                                                        | Where it lives                               |
| ----------- | --------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------- |
| Live push   | VAH → SOC | `POST /api/integrations/vstrike/findings`, batched                   | Findings + auto-clustered cases; resolutions via `PATCH /api/v1/findings/{id}` | `apps/desktop` main process (`SocForwarder`) |
| Bulk ingest | VAH → SOC | `POST /api/ingest/upload` + `ingest-string` via the `soc-export` CLI | Findings, and deliberately linked cases                                        | `packages/soc-export` CLI                    |
| MCP pull    | SOC → VAH | stdio MCP server (`mcp_config.json`)                                 | Nothing — read-only queries                                                    | `packages/soc-export` MCP server             |

All three share one mapping core (`packages/soc-export`) — the only module
that knows both schemas.

### Path 1 — live push

Enable **Settings → SOC export** in the desktop app: endpoint URL (https, or
http on localhost only), API key (stored encrypted with Electron
`safeStorage`, the same store as the AI keys), and the switch. The main
process subscribes to the same alert stream the AI explainer uses, batches
(50 findings or 5 seconds), and pushes with `source: "vigil-at-home"` and
`auto_cluster_cases: true`, so the SOC returns created findings _and_ their
case ids in one call. Resolving an alert at home PATCHes the finding closed
in the SOC. 5xx responses back off exponentially; the queue is bounded and
drops oldest under backpressure; local-only rules (the test and bench rules)
never forward.

### Path 2 — bulk ingest (CLI)

```bash
packages/soc-export/bin/soc-export.js export --db <vigil.db> --out alerts.jsonl [--since <iso>]
packages/soc-export/bin/soc-export.js upload --url <soc> --key-env SOC_API_KEY alerts.jsonl
packages/soc-export/bin/soc-export.js case   --url <soc> --key-env SOC_API_KEY case.json
```

`export` reads the local database and writes redacted JSONL (one finding per
line). `upload` posts the file to the authenticated ingest router and polls
the returned background job. `case` imports a case document whose
`finding_ids` link findings — the deliberate construction the auto-clustering
push path cannot show:

```json
{
  "case_id": "vah-case-1",
  "title": "Credential theft cluster",
  "finding_ids": ["vah-<alertId-1>", "vah-<alertId-2>"],
  "priority": "high",
  "tags": ["vigil-at-home"]
}
```

### Path 3 — MCP pull

The MCP server runs on the endpoint, over stdio, against the local database
opened read-only:

```json
{
  "mcpServers": {
    "vigil-at-home": {
      "command": "node",
      "args": [
        "--import",
        "tsx",
        "/path/to/Vigil-at-Home/packages/soc-export/src/mcp/main.ts",
        "--db=/path/to/vigil.db"
      ]
    }
  }
}
```

Three read-only tools, every response redaction-gated and byte-capped:

- `list_recent_alerts` — redacted summaries of recent alerts
- `get_alert` — one alert's finding-shaped detail
- `get_alert_evidence` — linked events through the evidence allowlist

Because stdio MCP servers are spawned by their consumer, the server must run
beside the Vigil SOC agent host. With a containerized Vigil SOC the consumer
spawns processes inside its own container and cannot see host paths — run
path 3 against a SOC started on the host (the demo's `soc-source-up.sh`, or
their `./start.sh -d`), or let the demo driver play the consumer.

## The alert → finding mapping

One deterministic function in `packages/soc-export`, fully unit-tested:

- **`finding_id`**: `vah-<alert id>` — stable, so a re-push updates instead
  of duplicating.
- **`severity`**: the alert's severity, with `info` mapped to `low` (the
  SOC's enum starts at low).
- **`anomaly_score`**: a deterministic, monotonic function of severity alone
  (0.2 for `low` … 1.0 for `critical`; `info` maps through `low`). The
  advisory AI confidence is carried in `entity_context`, never folded into
  the score.
- **`mitre_predictions`**: technique ids lifted from the **rule's** tags
  (alerts carry no MITRE field), weighted 0.9 for high-fidelity rules, 0.6
  otherwise.
- **`entity_context`**: allowlisted, redacted context — derived machine id,
  alert id, rule id@version, fidelity, subject, advisory AI verdict and
  confidence, user decision, containment.
- **Machine id**: derived at export time (alerts have no host field), as a
  salted hash of the local username and hostname — pseudonymous, and the
  local names themselves are scrubbed by the redactor.

## The optional fourth path: a SIEM relay

Vigil SOC already ingests from Elastic Security — its daemon polls the Kibana
Detections API with bi-directional case sync. A Vigil-at-Home → Elastic relay
would ride that documented route instead of talking to the SOC directly. It
is deliberately **not built** for this integration: it needs a running
Elastic stack, and every path above already reaches the SOC without one. If
your deployment already runs Elastic, that relay is the natural extension —
the mapping core in `packages/soc-export` is the reusable piece.

## Related surface: `apps/relay` (Streamable HTTP MCP)

A parallel effort in this repo — the MCP telemetry gateway (PRs #7, #13, #8),
`apps/relay` — serves MCP over **Streamable HTTP** for remote consumers. It
complements this integration rather than overlapping it: the relay exposes a
networked MCP surface, while the `soc-export` MCP server is the endpoint-local
stdio surface (see the `packages/soc-export` MCP instructions string). The
two can coexist; pick by topology — same-host agents use stdio, remote
consumers use the relay.

## Verify it end to end

`demo/` stands up a local Dockerized Vigil SOC, fires deterministic
detections through the bench stand-in fixture, drives all three paths, and
gates the result — see `demo/README.md`. The verification script exits
non-zero unless every path produced findings and at least one case exists in
the SOC.
