#!/usr/bin/env bash
set -euo pipefail

TIMEOUT_SECONDS=180
elapsed=0

echo "Waiting for all docker compose services to report healthy..."

while true; do
  unhealthy=$(docker compose ps --format '{{.Name}} {{.Health}}' \
    | awk '$2 != "healthy" && $2 != "" {print $1}')

  # Services without a HEALTHCHECK report empty status — treat "running" as OK for those.
  not_running=$(docker compose ps --format '{{.Name}} {{.State}}' \
    | awk '$2 != "running" {print $1}')

  if [[ -z "$unhealthy" && -z "$not_running" ]]; then
    echo "All services up."
    exit 0
  fi

  if (( elapsed >= TIMEOUT_SECONDS )); then
    echo "Timed out after ${TIMEOUT_SECONDS}s waiting for services to become healthy."
    docker compose ps
    exit 1
  fi

  sleep 5
  elapsed=$((elapsed + 5))
done
