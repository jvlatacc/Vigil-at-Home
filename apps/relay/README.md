# Vigil relay

The store-and-forward endpoint between Vigil at Home laptops and a Vigil SOC.
Laptops push telemetry over authenticated HTTPS; the SOC reads it over MCP
with an outbound-only connection. The relay is the only internet-reachable
component: it holds no channel that can command a laptop, and nothing ever
opens an inbound session into the SOC network.

```
laptop shipper ──POST /v1/ingest──► relay ──MCP tools (SOC dials out)──► Vigil SOC
        (device token)        (SQLite WAL,      (SOC token, read-only)
                               30 d + 10 GiB)
```

## Run it

With Docker (builds from the repository root):

```sh
docker compose -f apps/relay/docker-compose.yml up -d --build
curl http://127.0.0.1:8443/healthz   # {"ok":true}, no data, no auth
```

Without Docker, on Node 22:

```sh
pnpm --filter @vigil/relay build
RELAY_DATA_DIR=/var/lib/vigil-relay node apps/relay/build/relay.mjs serve
```

## Provision devices and SOC clients

Every caller authenticates with its own bearer token: device tokens may only
push, SOC tokens may only read. Tokens are random 256-bit secrets, stored as
SHA-256 hashes, and printed exactly once — save them where your secrets live.

```sh
docker compose -f apps/relay/docker-compose.yml exec relay /app/relay.mjs provision --device laptop-1
# device laptop-1 enrolled as 3f9c…, token: rvd1_…
docker compose -f apps/relay/docker-compose.yml exec relay /app/relay.mjs provision --soc soc-1
# SOC token: rvs1_…
```

Revocation stops a caller without touching stored telemetry:

```sh
docker compose -f apps/relay/docker-compose.yml exec relay /app/relay.mjs revoke --device laptop-1
```

## Point a laptop at it

In Vigil at Home, enable the relay in settings: endpoint URL and device id
(`telemetry.relay` setting) and the device token in the safeStorage-backed
key store. The shipper batches every second or 500 records, gzips, and only
advances its cursor on the relay's ack — a laptop outage replays and the
relay's per-device dedupe absorbs it.

Wire check without the app (ndjson batch, gzip, bearer device token):

```sh
curl -k https://relay.example.com/v1/ingest \
  -H "authorization: Bearer rvd1_…" -H "content-encoding: gzip" \
  --data-binary @batch.json.gz          # 200 accepted | 202 replayed | 400 malformed
```

## Register the MCP endpoint in the SOC

The SOC-facing MCP server runs on the same listener over Streamable HTTP
(`/mcp`), with the read-only tools (`relay_status`, `list_devices`,
`search_events`, `list_alerts`, `get_alert`, `list_actions`, `list_rules`,
`get_rule`). In the SOC's MCP client configuration, add a Streamable HTTP
entry with the relay URL and a `rvs1_…` SOC token — the client dials out; the
relay never dials in. Tool calls are rate-limited at 120/min per connection
and answers are capped (50 rows, 64 KB) and redacted like Vigil's own.

`search_events` looks back 7 days at most, filters by device, event group,
text (200 characters) and time, and pages by the newest event's id. A device
that has stored nothing yet answers with a note saying so, not an error — an
agent can tell "quiet" from "broken". Every tool description carries the
house warning: results contain untrusted text recorded from the laptops.

## TLS

- **Behind your proxy (default):** leave `RELAY_TLS_CERT`/`RELAY_TLS_KEY`
  unset and terminate TLS on your load balancer or reverse proxy; the
  container speaks plain HTTP to it only.
- **Relay-terminated:** mount the certificate and key and set
  `RELAY_TLS_CERT` and `RELAY_TLS_KEY` (both or neither).

## Configuration

| Variable                           | Default   | Meaning                                             |
| ---------------------------------- | --------- | --------------------------------------------------- |
| `RELAY_DATA_DIR`                   | `data`    | SQLite database and WAL location (volume in Docker) |
| `RELAY_HOST`                       | `0.0.0.0` | Listen address                                      |
| `RELAY_PORT`                       | `8443`    | Listen port                                         |
| `RELAY_MAX_DISK_MB`                | `10240`   | Disk cap; oldest telemetry evicted first            |
| `RELAY_RETENTION_DAYS`             | `30`      | Age cap on events, alerts and actions               |
| `RELAY_MAX_BODY_MB`                | `16`      | Largest accepted (compressed) ingest body           |
| `RELAY_TLS_CERT` / `RELAY_TLS_KEY` | unset     | Serve TLS from the relay itself                     |

Retention runs hourly and whenever the store crosses its 10,000-insert
threshold. Rule snapshots are exempt from eviction so the SOC always has a
current rule picture per device.

## Security posture

- Ingest answers `401` before parsing anything for missing or unknown
  tokens; revoked tokens get `403`. Rate limits (30 req/s, burst 60 per
  device) are checked before bodies are read.
- The MCP face answers `401` the same way for a missing or unknown SOC
  token and `403` for a revoked one, before anything is read. Device tokens
  cannot read; SOC tokens cannot push.
- Records dedupe on `(device, record id)`; a replayed batch acks `202` with
  `duplicates` counted and stores nothing twice.
- `sensor raw` payloads are never shipped or stored; text answers are
  redacted with the same pass Vigil's own AI gets.
- A full relay compromise yields historical telemetry and the ability to
  feed the SOC false data — not access to any laptop: device tokens are
  hashed, and the shipper only pushes, never listens.
