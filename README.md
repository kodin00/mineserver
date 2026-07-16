# Mineserver Panel

A self-hosted React and TypeScript control panel for multiple isolated Minecraft Java servers. It generates one Docker Compose project per server using `itzg/minecraft-server`, keeps world data on the host, provides live logs and RCON commands, manages JAR/ZIP add-ons, and creates consistent ZIP backups.

## Requirements

- Linux with Docker Engine and Docker Compose v2
- A trusted host or LAN; the API has Docker socket access and therefore host-level authority
- Ports for the panel and each Minecraft server

## Production installation

```sh
cp .env.example .env
# Edit .env and set a strong ADMIN_PASSWORD.
sudo mkdir -p /opt/mineserver
docker compose up -d --build
```

Open `http://your-host:8080` and sign in with `ADMIN_PASSWORD`. The initial password is Argon2-hashed into SQLite; changing the environment variable later does not overwrite it.

For access beyond a trusted LAN, place the panel behind an HTTPS reverse proxy, set `COOKIE_SECURE=true`, and restrict access with a firewall or VPN. Do not publish the API service or RCON port.

## Local development

Node.js 22 or newer is required.

```sh
npm install
npm run dev
```

The web app runs at `http://localhost:5173` and proxies API/WebSocket traffic to port 3001. Development defaults to `change-me-now-please`; override `ADMIN_PASSWORD` before sharing the service.

Docker is optional for UI/API development. Lifecycle integration requires a Linux Docker host with a Compose v2 CLI and writable runtime directory:

```sh
DATA_ROOT="$PWD/runtime" ADMIN_PASSWORD="a-long-development-password" npm run dev
```

## Storage

The default host root is `/opt/mineserver`. If changed, it is mounted at the same absolute path inside the API because generated sibling-container bind mounts are resolved by the host Docker daemon.

```text
/opt/mineserver/
├── panel.sqlite
├── instances/<uuid>/
│   ├── compose.yaml
│   ├── data/
│   ├── addons/
│   ├── backups/
│   └── secrets/rcon_password
└── archived/
```

Deleting a server archives this directory by default. Permanent deletion requires a separate checkbox and typed confirmation.

## Supported behavior

- Vanilla, Paper, Fabric, Forge, and NeoForge
- Automatic Java tag selection with a per-server override
- Explicit apply/restart for saved configuration changes
- Paper plugins and mod-loader mods as individual JARs or safe bulk ZIPs
- File explorer with recursive search and an atomic, conflict-aware text editor
- Individual JAR downloads, bulk add-on ZIP downloads, and name/date sorting
- One-time public ZIP links for sharing the current mod or plugin set
- Manual and cron-scheduled ZIP backups with count/day retention
- Restore into staging, pre-restore safety archive, health check, and automatic rollback

ZIP uploads accept only JAR entries. Absolute paths, traversal paths, duplicate names, non-JAR content, oversized expansion, and collisions with installed add-ons are rejected.

One-time add-on links store only a SHA-256 token hash. The first public `GET` atomically consumes the token before streaming starts, all later requests receive `404`, and responses are marked non-cacheable. Unused links expire after `ADDON_SHARE_TTL_MINUTES` (60 by default), while public attempts are limited per client IP by `PUBLIC_DOWNLOAD_RATE_LIMIT` (10 per minute by default). Because redemption happens when a download starts, an interrupted transfer cannot be retried; generate a new link instead.

The bundled nginx proxy overwrites client forwarding headers and the API trusts exactly one proxy hop. If the API is deployed through a different proxy topology, adjust `TRUST_PROXY_HOPS` and forwarding headers together so rate limiting cannot be bypassed with spoofed headers.

The file editor is restricted to UTF-8 configuration and text formats under a server's `data/` directory. Symbolic links and path traversal are rejected, files are size-limited by `MAX_EDIT_FILE_BYTES`, and concurrent on-disk changes must be reloaded before saving.

New backups use `.zip`. Existing `.tgz` and `.tar.gz` backups remain visible, downloadable, and restorable for migration compatibility.

After upgrading an existing installation, the panel rewrites legacy generated Compose files and marks those servers as awaiting apply. Apply or restart each server once to remove its old backup sidecar before relying on the new ZIP schedule.

## Verification

```sh
npm run typecheck
npm test
npm run build
docker compose config
```

End-to-end Docker actions cannot run without a Docker daemon. On a Linux test host, create two servers on different ports, start each, send `list` through the console, upload an add-on to the matching server type, trigger a backup, and perform a stopped-server restore.
