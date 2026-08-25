# Mineserver Panel

Run and manage multiple Minecraft Java servers from one simple web panel. Create servers, view logs, run console commands, install mods or plugins, and make backups—all from your browser.

## Quick start

You need a Linux machine with [Docker Engine](https://docs.docker.com/engine/install/) and Docker Compose v2 installed.

### Install from GHCR

This uses the published images, so Docker does not need to build the project locally:

```sh
mkdir mineserver && cd mineserver
curl -fsSLO https://raw.githubusercontent.com/kodin00/mineserver/master/compose.yaml
curl -fsSLO https://raw.githubusercontent.com/kodin00/mineserver/master/.env.example
cp .env.example .env
```

Open `.env` and replace `ADMIN_PASSWORD` with a unique password of at least 12 characters, then start the panel:

```sh
sudo mkdir -p /opt/mineserver
docker compose pull
docker compose up -d
```

Open `http://your-server-ip:8080` and sign in with the password from `.env`.

### Install from source

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
- Browse Modrinth from inside the panel and install mods, plugins, or datapacks in one click
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

## Mod marketplace

The **Browse** tab on a server searches [Modrinth](https://modrinth.com) filtered
to that server's loader and Minecraft version, then downloads and verifies the
file for you. Mods, plugins, and datapacks install directly. Resource packs and
shaders are listed for reference only, because a Minecraft server has nowhere to
install them.

No account or API key is needed. The panel needs outbound HTTPS access to
`api.modrinth.com` and `cdn.modrinth.com`.

Everything optional is configured in the panel under **Settings**, not in
`.env`:

- **Enable the marketplace.** Turn it off for an air-gapped install and the
  panel will not contact Modrinth at all. The Browse tab disappears.
- **Contact details.** Sent in the User-Agent. Modrinth asks for this so they
  can reach you about API usage instead of silently blocking the panel.
- **Access token.** Only needed to reach projects that are private to your own
  Modrinth account. It does **not** raise the rate limit, so leave it blank
  unless you know you need it. The panel checks the token when you save it and
  tells you whether Modrinth accepted it. The token is never shown again after
  saving and is never sent to the file CDN.

`MODRINTH_ENABLED` in `.env` only seeds the initial value on first run; after
that the Settings page is authoritative. The remaining `MODRINTH_*` variables
are deployment tuning (timeouts, request budget, size cap) and stay in `.env`.

Modrinth allows 300 API requests per minute per IP address, shared by everyone
using the panel. The panel keeps itself well under that, caches responses, and
backs off on its own if Modrinth reports the budget is spent.

Installed files land in the same place as uploaded ones, so a server restart is
still required before they load. Datapacks additionally need `/reload` and
`/datapack enable`, or a restart, before they take effect.

## Updating

For a GHCR installation, pull the latest images and restart:

```sh
docker compose pull
docker compose up -d
```

For a source installation, pull the new version and rebuild:

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
