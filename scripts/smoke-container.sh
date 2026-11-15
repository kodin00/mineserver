#!/usr/bin/env bash
set -euo pipefail

# Match a fresh install: the data directory exists, is owned by root, and is
# bind-mounted at the same path inside the API container. This runs only in CI
# on a Linux Docker host with sudo available.
data_root=$(mktemp -d "${RUNNER_TEMP:-/tmp}/mineserver-smoke.XXXXXXXX")
project="mineserver-smoke-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}"
export MINESERVER_DATA_ROOT="$data_root"
export MINESERVER_TAG="smoke-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}"
export ADMIN_PASSWORD
ADMIN_PASSWORD=$(openssl rand -hex 32)

cleanup() {
  result=$?
  if [[ "$result" -ne 0 ]]; then
    docker compose -p "$project" logs --no-color --tail=80 api >&2 || true
  fi
  docker compose -p "$project" down --remove-orphans >/dev/null 2>&1 || true
  sudo rm -rf -- "$data_root"
}
trap cleanup EXIT
sudo chown root:root "$data_root"
sudo chmod 755 "$data_root"

docker compose -p "$project" up --build --no-deps -d api
container=$(docker compose -p "$project" ps -q api)
if [[ -z "$container" ]]; then
  echo "API container was not created" >&2
  exit 1
fi

for ((attempt = 0; attempt < 30; attempt++)); do
  status=$(docker inspect --format '{{.State.Health.Status}}' "$container")
  if [[ "$status" == healthy ]]; then
    break
  fi
  if [[ "$status" == unhealthy || "$(docker inspect --format '{{.State.Running}}' "$container")" != true ]]; then
    echo "API failed to become healthy (status: $status)" >&2
    exit 1
  fi
  sleep 2
done
if [[ "$status" != healthy ]]; then
  echo "API health check timed out (status: $status)" >&2
  exit 1
fi

# Health alone does not exercise access to the mounted Docker socket.
docker compose -p "$project" exec -T api docker info >/dev/null
printf '%s\n' 'API is healthy and can access the Docker daemon.'
