# @vigil/soc-export

Feeds Vigil SOC from Vigil at Home. Everything here is **opt-in (off by
default)** and **redacted before anything leaves the machine** — the
local-first promise (no server, no account) is why this package exists at
all.

## What is in the package

| Surface         | Module                                          | What it does                                                                                                                                                                                |
| --------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mapping core    | `mapping.ts`                                    | The one place an `Alert` becomes a Vigil SOC finding: deterministic `anomaly_score` from severity, `info → low`, MITRE ids lifted from `Rule.tags`, stable `finding_id` (`vah-<alert id>`). |
| Machine id      | `machine.ts`                                    | A stable per-machine pseudonym hashed from the hostname — alerts and events carry no host field.                                                                                            |
| Push transport  | `transport.ts`, `batch-queue.ts`, `safe-url.ts` | Batched push to the VStrike findings receiver with bounded retry/backoff, and resolution updates over the frozen `PATCH /api/v1/findings/{id}`. https-or-localhost endpoints only.          |
| Config          | `config.ts`                                     | Opt-in settings; `enablementErrors` gates "on" behind an endpoint, a key, and a safe URL.                                                                                                   |
| MCP pull server | `src/mcp/`                                      | What Vigil SOC's agents can ask this machine, over stdio — read-only. Below.                                                                                                                |

## The MCP pull server (`src/mcp/`)

Vigil SOC consumes MCP servers over stdio (`mcp_config.json`). This one runs
on the endpoint and exposes three read-only tools over a **read-only SQLite
connection** to `vigil.db`:

- `list_recent_alerts({ since_min?, severity?, limit? })` — alerts raised in
  the window (default 24 h), newest first.
- `get_alert({ id })` — one alert in full: rule, advisory AI assessment, the
  user's decision, containment.
- `get_alert_evidence({ id })` — the sensor events behind an alert, oldest
  first.

Every tool answer leaves through one boundary: **`redactAndSerialize` with a
64 KB cap** (the house reply cap, shared with the desktop's own MCP tools and
`apps/relay`). Redaction runs first; the byte cap is met by dropping or
withholding whole fields — never by cutting a string, which could leave part
of a secret behind. What was left out is reported in a note that carries
counts only. A single oversize field — a huge `raw` sensor record — is
withheld whole, not truncated.

Writes are impossible twice over: the connection is opened
`readOnly: true` (SQLite refuses writes at the engine), and the server
registers nothing but read tools.

### Running it

The server is TS source, like every package here. Spawn it with a TS-capable
runner:

```jsonc
// Vigil SOC's mcp_config.json (or the equivalent in Settings → Integrations)
{
  "mcpServers": {
    "vigil-at-home": {
      "command": "node",
      "args": ["--import", "tsx", "packages/soc-export/src/mcp/main.ts", "--db=<path to vigil.db>"],
    },
  },
}
```

`bun packages/soc-export/src/mcp/main.ts --db=...` works too. The process
speaks MCP on stdout; diagnostics go to stderr.

## Relationship to `apps/relay`

This MCP server **complements `apps/relay`** (the `feat/relay-mcp` effort):
the relay ships telemetry from many laptops to a hosted service and serves it
SOC-facing over Streamable HTTP; this server runs **on the endpoint itself**,
**pull-side**, **read-only**, **redaction-gated at the tool boundary**, for
the local and demo case. The two share the house conventions — snake_case
tool names, the 50-row / 64 KB caps, the untrusted-content suffix on every
description — but have no code in common and no file overlap. The relay is
the multi-device product path; this is the single-machine pull path.
