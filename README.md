# Mineserver Panel

Run and manage multiple Minecraft Java servers from one simple web panel. Create servers, view logs, run console commands, install mods or plugins, and make backups—all from your browser.

## Quick start

You need a Linux machine with [Docker Engine](https://docs.docker.com/engine/install/) and Docker Compose v2 installed.

1. Download or clone this project onto the machine that will run your Minecraft servers.
2. Create your settings file and choose a strong password:

   ```sh
   cp .env.example .env
   ```

   Open `.env` and replace `ADMIN_PASSWORD` with a unique password of at least 12 characters.

3. Start the panel:

   ```sh
   sudo mkdir -p /opt/mineserver
   docker compose up -d --build
   ```

4. Open `http://your-server-ip:8080` and sign in with the password from `.env`.

5. Create a Minecraft server in the panel, choose its type and version, then start it.

Your server worlds, backups, and settings are saved in `/opt/mineserver` by default, so they survive container updates and restarts.

## Before sharing it online

This panel can control Docker on its host. Keep it on a trusted network whenever possible.

For remote access, put it behind an HTTPS reverse proxy, set `COOKIE_SECURE=true` in `.env`, and protect it with a firewall or VPN. Do not expose the API service or Minecraft RCON ports directly.

## Common settings

Edit `.env` before starting the panel to change these values:

| Setting                | Default           | What it changes                                   |
| ---------------------- | ----------------- | ------------------------------------------------- |
| `ADMIN_PASSWORD`       | required          | Password used to sign in.                         |
| `PANEL_PORT`           | `8080`            | Port used to open the panel.                      |
| `MINESERVER_DATA_ROOT` | `/opt/mineserver` | Where worlds, backups, and panel data are stored. |
| `TZ`                   | `Asia/Jakarta`    | Time zone used for scheduled backups.             |
| `COOKIE_SECURE`        | `false`           | Set to `true` when using HTTPS.                   |

After changing settings, restart the panel:

```sh
docker compose up -d
```

Changing `ADMIN_PASSWORD` after the first login does not change the existing password. It is stored securely in the panel database.

## What you can do in the panel

- Run Vanilla, Paper, Fabric, Forge, or NeoForge servers
- Sleep empty servers after a configurable delay and wake them when a player joins
- Start, stop, and restart servers; view live logs; send console commands
- Upload Paper plugins or mod-loader mods as JAR files or ZIP archives
- Browse and safely edit server configuration files
- Create, download, schedule, restore, and retain ZIP backups
- Create one-time download links for installed add-ons

## Wake on join

Enable **Sleep when nobody is playing and wake on join** in a server's
settings, choose the empty-server timeout, then apply the pending change. The
panel puts a small Minecraft-aware proxy on that server's host port and keeps
the full game container off while it is empty. A player can use the same
address as before; their first connection starts the game container.

The proxy needs access to the Docker socket to start and gracefully stop its
managed game container. Keep the host port limited to the networks or players
that should be able to wake the server. The initial connection may show a
starting message or require one retry while Minecraft finishes booting.

## Updating

From the project folder, pull the new version and rebuild:

```sh
git pull
docker compose up -d --build
```

Existing Minecraft data is kept in `MINESERVER_DATA_ROOT`. After an upgrade, open the panel and apply or restart each existing server once if it is marked as awaiting apply.

## Local development

Node.js 22 or newer is required.

```sh
npm install
npm run dev
```

Open `http://localhost:5173`. To use Docker server management during development on a Linux Docker host:

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
