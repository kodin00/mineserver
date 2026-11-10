# Mineserver Panel

Run and manage multiple Minecraft Java servers from one web panel. Create servers, view logs, run console commands, install mods or plugins, and make backups—all from your browser.

## Quick start

Requires a Linux machine with [Docker Engine](https://docs.docker.com/engine/install/), Docker Compose v2, and `curl`.

```sh
curl -fsSL https://raw.githubusercontent.com/kodin00/mineserver/master/install.sh | sh
```

This creates a `mineserver` folder, pulls the images from GHCR, and starts the panel. Sign in at `http://localhost:8080` with the default password `mineserver123!`. To use a different password, set `ADMIN_PASSWORD` in `mineserver/.env` before the first start.

Worlds, backups, and panel data are saved in `/opt/mineserver`, so they survive container restarts and updates.

### Without the install script

Uses the same published GHCR images, no local build needed:

```sh
mkdir mineserver && cd mineserver
curl -fsSLO https://raw.githubusercontent.com/kodin00/mineserver/master/compose.yaml
curl -fsSLO https://raw.githubusercontent.com/kodin00/mineserver/master/.env.example
cp .env.example .env
sudo mkdir -p /opt/mineserver
docker compose pull
docker compose up -d
```

### From source

```sh
cp .env.example .env
docker compose up -d --build
```

To reach the panel from another machine, set `PANEL_BIND=0.0.0.0` in `.env` and use `http://your-server-ip:8080`.

## Security notes

This panel can control Docker on its host. Keep it on a trusted network. It binds to `127.0.0.1` by default; set `PANEL_BIND=0.0.0.0` to open it to your LAN. For remote access, put it behind an HTTPS reverse proxy, set `COOKIE_SECURE=true`, and use a firewall or VPN. Do not expose the API service or Minecraft RCON ports directly.

## Common settings

Edit `.env` before starting the panel. After changing settings, restart with `docker compose up -d`.

| Setting                | Default           | What it changes                                   |
| ---------------------- | ----------------- | ------------------------------------------------- |
| `ADMIN_PASSWORD`       | `mineserver123!`  | Password used to sign in.                         |
| `PANEL_PORT`           | `8080`            | Port used to open the panel.                      |
| `MINESERVER_DATA_ROOT` | `/opt/mineserver` | Where worlds, backups, and panel data are stored. |
| `TZ`                   | `Asia/Jakarta`    | Time zone used for scheduled backups.             |
| `COOKIE_SECURE`        | `false`           | Set to `true` when using HTTPS.                   |

Changing `ADMIN_PASSWORD` after the first login has no effect—the password is stored in the panel database.

## What you can do in the panel

- Run Vanilla, Paper, Fabric, Forge, or NeoForge servers
- Start, stop, and restart servers; view live logs; send console commands
- Sleep empty servers after a configurable delay and wake them when a player joins
- Browse Modrinth from inside the panel and install mods, plugins, or datapacks in one click
- Upload plugins or mods as JAR files or ZIP archives
- Browse and safely edit server configuration files
- Create, download, schedule, restore, and retain ZIP backups
- Create one-time download links for installed add-ons

## Wake on join

Enable **Sleep when nobody is playing and wake on join** in a server's settings. The panel puts a small Minecraft-aware proxy on that server's port and keeps the game container off while it is empty; a player joining with the same address as before starts it. The first connection may show a starting message or need one retry while the server boots.

## Mod marketplace

The **Browse** tab on a server searches [Modrinth](https://modrinth.com), filtered to that server's loader and Minecraft version, and installs mods, plugins, and datapacks with verification. No account or API key is needed; the panel only needs outbound HTTPS to `api.modrinth.com` and `cdn.modrinth.com`. Everything optional (enable/disable, contact details, private-project token) is configured in the panel under **Settings**, not in `.env`. A server restart is required after installing files; datapacks also need `/reload` or a restart.

## Updating

GHCR installation:

```sh
docker compose pull
docker compose up -d
```

Source installation:

```sh
git pull
docker compose up -d --build
```

After an upgrade, open the panel and apply or restart each existing server once if it is marked as awaiting apply.

## Local development

Requires Node.js 22 or newer.

```sh
npm install
npm run dev
```

Open `http://localhost:5173`. For Docker server management during development on a Linux Docker host:

```sh
DATA_ROOT="$PWD/runtime" ADMIN_PASSWORD="a-long-development-password" npm run dev
```

## Checks

```sh
npm run typecheck
npm test
npm run build
docker compose config
```
