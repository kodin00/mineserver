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

# Replace the publicly documented example password with a generated one unless
# the user already provided their own before running the installer.
if grep -q '^ADMIN_PASSWORD=mineserver123!' .env; then
  generated_password="$(od -An -N18 -tx1 /dev/urandom | tr -d ' \n')"
  sed -i.bak "s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=$generated_password|" .env
  rm -f .env.bak
  echo "Generated a random ADMIN_PASSWORD and wrote it to mineserver/.env."
  echo "Sign in with it, or change it later in the panel after first login."
fi

sudo mkdir -p /opt/mineserver
docker compose pull
docker compose up -d
