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

mkdir -p mineserver
cd mineserver
curl -fsSLo compose.yaml "$repo_url/compose.yaml"
curl -fsSLo .env.example "$repo_url/.env.example"
[ -f .env ] || cp .env.example .env
# .env holds the admin password; keep it private to the installing user.
chmod 600 .env

data_root="$(grep '^MINESERVER_DATA_ROOT=' .env | cut -d= -f2- || true)"
: "${data_root:=/opt/mineserver}"
if [ "$(id -u)" -eq 0 ]; then
  mkdir -p "$data_root"
else
  if ! command -v sudo >/dev/null 2>&1; then
    echo "Error: creating $data_root requires root privileges, but 'sudo' is not installed." >&2
    echo "Run this installer as root, or install sudo and re-run it." >&2
    exit 1
  fi
  sudo mkdir -p "$data_root"
fi
docker compose pull
if ! docker compose up -d; then
  echo "Mineserver failed to start. API logs:" >&2
  docker compose logs --tail=80 api >&2 || true
  exit 1
fi

echo
echo "Mineserver is running at http://localhost:8080"
echo "Sign in with the default password 123456 (unless you set your own ADMIN_PASSWORD in mineserver/.env)."
echo "Change it after your first login in Account settings."
