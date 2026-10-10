#!/usr/bin/env bash
# Stand up the Dockerized Vigil SOC quick start and health-check the API.
# Reuses an existing clone; pass SOC_DIR to place it elsewhere.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN_DIR="$ROOT/demo/.run"
SOC_REPO="${SOC_REPO:-https://github.com/Vigil-SOC/vigil.git}"
SOC_DIR="${SOC_DIR:-$RUN_DIR/vigil-soc}"
SOC_URL="${SOC_URL:-http://127.0.0.1:6987}"
COMPOSE_FILE="infra/docker/docker-compose.yml"

mkdir -p "$RUN_DIR"

if [ ! -d "$SOC_DIR/.git" ]; then
  echo "[soc-up] cloning $SOC_REPO into $SOC_DIR"
  git clone --depth 1 "$SOC_REPO" "$SOC_DIR"
fi

cd "$SOC_DIR"

if [ ! -f .env ]; then
  echo "[soc-up] writing .env from env.example (DEV_MODE on — local demo only)"
  cp env.example .env
  chmod 600 .env
fi
# The demo runs locally and without auth (the project's DEV_MODE default):
# no secrets are involved, but the setting must be explicit.
if grep -q '^DEV_MODE=' .env; then
  sed -i.bak 's/^DEV_MODE=.*/DEV_MODE=true/' .env && rm -f .env.bak
else
  printf 'DEV_MODE=true\n' >> .env
fi
# The agent layer wants an internal token even when it never leaves the machine
# (unset, every /internal call answers 503 and no workflow can run), and the
# backend refuses to boot without a JWT secret unless auth is bypassed.
if ! grep -q '^AGENT_INTERNAL_TOKEN=..*' .env; then
  TOKEN="$(openssl rand -urlsafe 48 2>/dev/null || head -c 48 /dev/urandom | base64 | tr -d '\n')"
  if grep -q '^AGENT_INTERNAL_TOKEN=' .env; then
    sed -i.bak "s/^AGENT_INTERNAL_TOKEN=.*/AGENT_INTERNAL_TOKEN=$TOKEN/" .env && rm -f .env.bak
  else
    printf 'AGENT_INTERNAL_TOKEN=%s\n' "$TOKEN" >> .env
  fi
fi
if ! grep -q '^JWT_SECRET_KEY=..*' .env; then
  JWT="$(openssl rand -base64 48 2>/dev/null || head -c 64 /dev/urandom | base64 | tr -d '\n')"
  if grep -q '^JWT_SECRET_KEY=' .env; then
    sed -i.bak "s|^JWT_SECRET_KEY=.*|JWT_SECRET_KEY=$JWT|" .env && rm -f .env.bak
  else
    printf 'JWT_SECRET_KEY=%s\n' "$JWT" >> .env
  fi
fi

echo "[soc-up] docker compose up -d (first run pulls several images — be patient)"
docker compose --env-file .env -f "$COMPOSE_FILE" up -d

echo "[soc-up] waiting for the API at $SOC_URL"
for _ in $(seq 1 120); do
  if curl -sf "$SOC_URL/docs" >/dev/null 2>&1 || curl -sf "$SOC_URL/" >/dev/null 2>&1; then
    echo "[soc-up] Vigil SOC is up (API :6987, UI :6988)"
    exit 0
  fi
  sleep 2
done

echo "[soc-up] the API did not become healthy in time; compose state:"
docker compose --env-file .env -f "$COMPOSE_FILE" ps
docker compose --env-file .env -f "$COMPOSE_FILE" logs --tail 40
exit 1
