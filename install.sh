#!/usr/bin/env sh
set -eu

repo_url="https://raw.githubusercontent.com/kodin00/mineserver/master"

command -v curl >/dev/null 2>&1 || {
  echo "curl is required to install Mineserver." >&2
  exit 1
}
command -v docker >/dev/null 2>&1 || {
  echo "Docker with Docker Compose v2 is required to install Mineserver." >&2
  exit 1
}
docker compose version >/dev/null 2>&1 || {
  echo "Docker Compose v2 is required to install Mineserver." >&2
  exit 1
}

mkdir mineserver
cd mineserver
curl -fsSLo compose.yaml "$repo_url/compose.yaml"
curl -fsSLo .env.example "$repo_url/.env.example"
cp .env.example .env
sudo mkdir -p /opt/mineserver
docker compose pull
docker compose up -d
