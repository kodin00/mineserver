import path from "node:path";
import { createHash } from "node:crypto";
import { chmod, chown, mkdir, writeFile } from "node:fs/promises";
import YAML from "yaml";
import {
  addonKind,
  automaticJavaTag,
  reservedEnvironmentKeys,
  type ServerConfig,
} from "@mineserver/shared";
import { randomToken } from "./utils.js";

const minecraftUid = 1000;
const minecraftGid = 1000;

async function ensureRconSecretReadableByMinecraft(pathname: string) {
  if (process.getuid?.() !== 0) return;
  await chown(pathname, minecraftUid, minecraftGid);
  await chmod(pathname, 0o600);
}

export interface InstancePaths {
  root: string;
  compose: string;
  data: string;
  addons: string;
  backups: string;
  backupMigrationMarker: string;
  secrets: string;
  rconSecret: string;
}

export function instancePaths(
  instancesRoot: string,
  id: string,
): InstancePaths {
  const root = path.join(instancesRoot, id);
  return {
    root,
    compose: path.join(root, "compose.yaml"),
    data: path.join(root, "data"),
    addons: path.join(root, "addons"),
    backups: path.join(root, "backups"),
    backupMigrationMarker: path.join(root, ".zip-backup-migration-pending"),
    secrets: path.join(root, "secrets"),
    rconSecret: path.join(root, "secrets", "rcon_password"),
  };
}

function bool(value: boolean) {
  return value ? "TRUE" : "FALSE";
}

function containerMemoryLimit(maxMemory: string): string | undefined {
  const match = /^(\d+(?:\.\d+)?)([GMK])$/i.exec(maxMemory);
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unit = match[2]!.toUpperCase();
  const mebibytes =
    unit === "G" ? amount * 1024 : unit === "M" ? amount : amount / 1024;
  return `${Math.ceil(mebibytes * 1.25)}M`;
}

function sleepNetwork(id: string) {
  const digest = createHash("sha256").update(id).digest();
  const network = digest.readUInt32BE(0) & 0x1fffff;
  const second = (network >> 13) & 0xff;
  const third = (network >> 5) & 0xff;
  const fourth = (network & 0x1f) * 8;
  const prefix = `10.${second}.${third}.${fourth}`;
  return {
    subnet: `${prefix}/29`,
    proxyAddress: `10.${second}.${third}.${fourth + 2}`,
    serverAddress: `10.${second}.${third}.${fourth + 3}`,
  };
}

export function environmentFor(config: ServerConfig): Record<string, string> {
  const environment: Record<string, string> = {
    EULA: "TRUE",
    TYPE: config.type,
    VERSION: config.version,
    INIT_MEMORY: config.initMemory,
    MAX_MEMORY: config.maxMemory,
    VIEW_DISTANCE: String(config.viewDistance),
    SIMULATION_DISTANCE: String(config.simulationDistance),
    MAX_PLAYERS: String(config.maxPlayers),
    MOTD: config.motd,
    DIFFICULTY: config.difficulty,
    MODE: config.gameMode,
    PVP: bool(config.pvp),
    ONLINE_MODE: bool(config.onlineMode),
    ALLOW_FLIGHT: bool(config.allowFlight),
    ENABLE_RCON: "TRUE",
    RCON_PASSWORD_FILE: "/run/secrets/rcon_password",
  };
  if (config.serverIconUrl) {
    environment.ICON = config.serverIconUrl;
    environment.OVERRIDE_ICON = "TRUE";
  }
  if (config.seed) environment.SEED = config.seed;
  if (config.whitelist.length) {
    environment.ENABLE_WHITELIST = "TRUE";
    environment.WHITELIST = config.whitelist.join(",");
  }
  if (config.operators.length) environment.OPS = config.operators.join(",");
  const properties = Object.entries(config.customProperties)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  if (properties) environment.CUSTOM_SERVER_PROPERTIES = properties;
  for (const [key, value] of Object.entries(config.advancedEnv)) {
    if (!reservedEnvironmentKeys.has(key)) environment[key] = value;
  }
  return environment;
}

export function renderCompose(
  id: string,
  config: ServerConfig,
  paths: InstancePaths,
): string {
  const kind = addonKind(config.type);
  const memoryLimit = containerMemoryLimit(config.maxMemory);
  const autoSleep = config.autoSleep.enabled;
  const network = sleepNetwork(id);
  const volumes = [`${paths.data}:/data`];
  if (kind) volumes.push(`${paths.addons}:/${kind}:ro`);

  const minecraft = {
    image: `itzg/minecraft-server:${config.javaTag || automaticJavaTag(config.version)}`,
    ...(memoryLimit ? { mem_limit: memoryLimit } : {}),
    // The sleep proxy owns restarts when enabled. Otherwise retry one
    // unexpected failure, then leave a broken server stopped.
    restart: autoSleep ? "no" : "on-failure:1",
    tty: true,
    stdin_open: true,
    ...(!autoSleep ? { ports: [`${config.port}:25565`] } : {}),
    environment: environmentFor(config),
    volumes,
    secrets: ["rcon_password"],
    healthcheck: {
      test: ["CMD", "mc-health"],
      interval: "10s",
      timeout: "5s",
      retries: 12,
      start_period: "60s",
    },
    labels: {
      "app.mineserver.managed": "true",
      "app.mineserver.instance": id,
      ...(autoSleep
        ? {
            "lazymc.enabled": "true",
            "lazymc.group": `mineserver-${id}`,
            "lazymc.server.address": "mc:25565",
            "lazymc.server.directory": "/server",
            "lazymc.server.wake_whitelist": String(config.whitelist.length > 0),
            "lazymc.server.block_banned_ips": "true",
            ...(["FORGE", "NEOFORGE"].includes(config.type)
              ? { "lazymc.server.forge": "true" }
              : {}),
            "lazymc.time.sleep_after": String(
              config.autoSleep.idleMinutes * 60,
            ),
            "lazymc.time.minimum_online_time": "60",
            "lazymc.join.methods": "hold,kick",
            "lazymc.join.hold.timeout": "25",
            "lazymc.join.kick.starting":
              "Server is waking up. Please reconnect in a minute.",
            "lazymc.motd.sleeping": "Server is sleeping — join to wake it",
            "lazymc.motd.starting": "Server is waking up…",
          }
        : {}),
    },
    ...(autoSleep
      ? { networks: { minecraft: { ipv4_address: network.serverAddress } } }
      : {}),
  };

  const services: Record<string, unknown> = { mc: minecraft };
  if (autoSleep) {
    services.sleep_proxy = {
      image: "ghcr.io/joesturge/lazymc-docker-proxy:latest",
      restart: "unless-stopped",
      depends_on: ["mc"],
      ports: [`${config.port}:25565`],
      volumes: [
        "/var/run/docker.sock:/var/run/docker.sock:ro",
        `${paths.data}:/server:ro`,
      ],
      networks: { minecraft: { ipv4_address: network.proxyAddress } },
      labels: {
        "app.mineserver.managed": "true",
        "app.mineserver.instance": id,
        "app.mineserver.role": "sleep-proxy",
      },
    };
  }

  const document = {
    name: `mineserver-${id}`,
    services,
    ...(autoSleep
      ? {
          networks: {
            minecraft: {
              driver: "bridge",
              ipam: { config: [{ subnet: network.subnet }] },
            },
          },
        }
      : {}),
    secrets: {
      rcon_password: { file: paths.rconSecret },
    },
  };
  return `# Generated by Mineserver Panel. Changes will be overwritten.\n${YAML.stringify(document)}`;
}

export async function ensureInstanceLayout(paths: InstancePaths) {
  await Promise.all([
    mkdir(paths.data, { recursive: true }),
    mkdir(paths.addons, { recursive: true }),
    mkdir(paths.backups, { recursive: true }),
    mkdir(paths.secrets, { recursive: true }),
  ]);
  try {
    await writeFile(paths.rconSecret, `${randomToken(36)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error: any) {
    if (error?.code !== "EEXIST") throw error;
  }
  await ensureRconSecretReadableByMinecraft(paths.rconSecret);
}

export async function writeCompose(
  id: string,
  config: ServerConfig,
  paths: InstancePaths,
) {
  await ensureInstanceLayout(paths);
  await writeFile(paths.compose, renderCompose(id, config, paths), {
    mode: 0o600,
  });
}
