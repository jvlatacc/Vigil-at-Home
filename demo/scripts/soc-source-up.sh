#!/usr/bin/env bash
# OQ-2 fallback — path 3 only: run the Vigil SOC quick start from source on
# the host (their supported ./start.sh -d) so the stdio MCP server can be a
# sibling process of the consumer. Data stores (postgres, redis, bifrost) stay
# in Docker; the API, agent layer, and frontend run on the host.
#
# Paths 1-2 keep using the fully Dockerized stack (soc-up.sh); see
# demo/README.md for when this fallback applies.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN_DIR="$ROOT/demo/.run"
SOC_REPO="${SOC_REPO:-https://github.com/Vigil-SOC/vigil.git}"
SOC_DIR="${SOC_DIR:-$RUN_DIR/vigil-soc}"
SOC_URL="${SOC_URL:-http://127.0.0.1:6987}"

mkdir -p "$RUN_DIR"
if [ ! -d "$SOC_DIR/.git" ]; then
  echo "[soc-source-up] cloning $SOC_REPO into $SOC_DIR"
  git clone --depth 1 "$SOC_REPO" "$SOC_DIR"
fi
cd "$SOC_DIR"

if [ ! -f .env ]; then
  echo "[soc-source-up] writing .env from env.example"
  cp env.example .env
  chmod 600 .env
fi
# Same local-demo posture as the Docker route.
if grep -q '^DEV_MODE=' .env; then
  sed -i.bak 's/^DEV_MODE=.*/DEV_MODE=true/' .env && rm -f .env.bak
else
  printf 'DEV_MODE=true\n' >> .env
fi
if ! grep -q '^AGENT_INTERNAL_TOKEN=..*' .env; then
  TOKEN="$(openssl rand -urlsafe 48 2>/dev/null || head -c 48 /dev/urandom | base64 | tr -d '\n')"
  printf 'AGENT_INTERNAL_TOKEN=%s\n' "$TOKEN" >> .env
fi
if ! grep -q '^JWT_SECRET_KEY=..*' .env; then
  JWT="$(openssl rand -base64 48 2>/dev/null || head -c 64 /dev/urandom | base64 | tr -d '\n')"
  printf 'JWT_SECRET_KEY=%s\n' "$JWT" >> .env
fi

# Their supported host start: provisions uv, installs Python deps, brings up
# the Docker data stores, initializes the schema, then launches the API
# (-d: background, logs under logs/, pidfiles beside them).
./start.sh -d

echo "[soc-source-up] waiting for the API at $SOC_URL"
for _ in $(seq 1 150); do
  if curl -sf "$SOC_URL/docs" >/dev/null 2>&1 || curl -sf "$SOC_URL/" >/dev/null 2>&1; then
    echo "[soc-source-up] Vigil SOC is up from source (API :6987)"
    exit 0
  fi
  sleep 2
done
echo "[soc-source-up] the API did not become healthy in time; recent logs:"
tail -n 40 logs/*.log 2>/dev/null || true
exit 1
