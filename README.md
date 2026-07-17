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

| Setting | Default | What it changes |
| --- | --- | --- |
| `ADMIN_PASSWORD` | required | Password used to sign in. |
| `PANEL_PORT` | `8080` | Port used to open the panel. |
| `MINESERVER_DATA_ROOT` | `/opt/mineserver` | Where worlds, backups, and panel data are stored. |
| `TZ` | `Asia/Jakarta` | Time zone used for scheduled backups. |
| `COOKIE_SECURE` | `false` | Set to `true` when using HTTPS. |

After changing settings, restart the panel:

```sh
docker compose up -d
```

Changing `ADMIN_PASSWORD` after the first login does not change the existing password. It is stored securely in the panel database.

## What you can do in the panel

- Run Vanilla, Paper, Fabric, Forge, or NeoForge servers
- Start, stop, and restart servers; view live logs; send console commands
- Upload Paper plugins or mod-loader mods as JAR files or ZIP archives
- Browse and safely edit server configuration files
- Create, download, schedule, restore, and retain ZIP backups
- Create one-time download links for installed add-ons

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
