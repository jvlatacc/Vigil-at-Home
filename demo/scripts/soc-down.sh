#!/usr/bin/env bash
# Tear the demo's Vigil SOC stack down. Pass --volumes to also drop its data.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SOC_DIR="${SOC_DIR:-$ROOT/demo/.run/vigil-soc}"
COMPOSE_FILE="infra/docker/docker-compose.yml"

if [ ! -d "$SOC_DIR" ]; then
  echo "[soc-down] no clone at $SOC_DIR — nothing to stop"
  exit 0
fi
cd "$SOC_DIR"
docker compose --env-file .env -f "$COMPOSE_FILE" down "$@"
echo "[soc-down] stack stopped"
