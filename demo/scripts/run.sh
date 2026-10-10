#!/usr/bin/env bash
# The whole demo as one command: SOC up, alerts fired, all three paths run,
# and the acceptance gate. `--down` also tears the SOC stack down at the end.
#
#   bash demo/scripts/run.sh [--down]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

fail() {
  echo "[run] $1"
  exit "${2:-1}"
}

# The MCP server and the ingest CLI read the store with node:sqlite, which
# needs 22.13+; the repo's engines floor is 22.12.
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
NODE_MINOR=$(node -p 'process.versions.node.split(".")[1]')
[ "$NODE_MAJOR" -ge 22 ] && [ "$NODE_MINOR" -ge 13 ] || fail "node 22.13+ required (found $(node --version)); node:sqlite is not available on older 22.x" 3
docker info >/dev/null 2>&1 || fail "docker is required (the Vigil SOC quick start runs in Docker) and is not reachable from this shell" 3
[ -d node_modules ] || fail "dependencies are not installed — run 'pnpm install' first" 3

bash demo/scripts/soc-up.sh

TSX="pnpm exec tsx"
$TSX demo/scripts/produce-alerts.ts
$TSX demo/scripts/bulk-ingest.ts
$TSX demo/scripts/mcp-pull.ts
$TSX demo/scripts/verify.ts

echo "[run] PASS — every path left findings in Vigil SOC, and at least one case exists"
if [ "${1:-}" = "--down" ]; then
  bash demo/scripts/soc-down.sh
fi
