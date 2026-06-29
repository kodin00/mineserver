import { z } from "zod";

export const serverTypes = [
  "VANILLA",
  "PAPER",
  "FABRIC",
  "FORGE",
  "NEOFORGE",
] as const;
export const ServerTypeSchema = z.enum(serverTypes);
export type ServerType = z.infer<typeof ServerTypeSchema>;

export const gameModes = [
  "survival",
  "creative",
  "adventure",
  "spectator",
] as const;
export const difficulties = ["peaceful", "easy", "normal", "hard"] as const;

const memorySchema = z
  .string()
  .trim()
  .regex(/^\d+(?:\.\d+)?[GMK%]$/i, "Use a value such as 2G, 512M, or 75%");

const safeEnvKey = z
  .string()
  .regex(
    /^[A-Z][A-Z0-9_]*$/,
    "Environment keys must use uppercase letters, numbers, and underscores",
  );
const propertyKey = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]*$/, "Invalid server property name");

export const BackupSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  cron: z.string().trim().min(5).max(100).default("0 4 * * *"),
  retainDays: z.coerce.number().int().min(1).max(3650).default(7),
  retainCount: z.coerce.number().int().min(1).max(1000).default(14),
});
export type BackupSettings = z.infer<typeof BackupSettingsSchema>;

export const ServerConfigSchema = z
  .object({
    name: z.string().trim().min(1).max(64),
    version: z.string().trim().min(1).max(40).default("LATEST"),
    type: ServerTypeSchema.default("PAPER"),
    port: z.coerce.number().int().min(1024).max(65535).default(25565),
    javaTag: z.string().trim().max(64).nullable().default(null),
    initMemory: memorySchema.default("1G"),
    maxMemory: memorySchema.default("4G"),
    viewDistance: z.coerce.number().int().min(2).max(64).default(10),
    simulationDistance: z.coerce.number().int().min(2).max(64).default(10),
    maxPlayers: z.coerce.number().int().min(1).max(1000).default(20),
    motd: z.string().max(300).default("A Minecraft Server"),
    difficulty: z.enum(difficulties).default("normal"),
    gameMode: z.enum(gameModes).default("survival"),
    pvp: z.boolean().default(true),
    onlineMode: z.boolean().default(true),
    allowFlight: z.boolean().default(false),
    seed: z.string().max(128).default(""),
    whitelist: z.array(z.string().trim().min(1).max(40)).max(500).default([]),
    operators: z.array(z.string().trim().min(1).max(40)).max(100).default([]),
    advancedEnv: z.record(safeEnvKey, z.string().max(4000)).default({}),
    customProperties: z.record(propertyKey, z.string().max(2000)).default({}),
    backups: BackupSettingsSchema.default({
      enabled: true,
      cron: "0 4 * * *",
      retainDays: 7,
      retainCount: 14,
    }),
  })
  .superRefine((value, ctx) => {
    const toMiB = (input: string): number | null => {
      const match = /^(\d+(?:\.\d+)?)([GMK])$/i.exec(input);
      if (!match) return null;
      const amount = Number(match[1]);
      const unit = match[2]!.toUpperCase();
      return unit === "G"
        ? amount * 1024
        : unit === "M"
          ? amount
          : amount / 1024;
    };
    const initial = toMiB(value.initMemory);
    const maximum = toMiB(value.maxMemory);
    if (initial !== null && maximum !== null && initial > maximum) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["initMemory"],
        message: "Initial memory cannot exceed maximum memory",
      });
    }
  });

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

export const CreateServerSchema = ServerConfigSchema.and(
  z.object({
    acceptEula: z.literal(true, {
      errorMap: () => ({ message: "You must accept the Minecraft EULA" }),
    }),
  }),
);
export type CreateServerInput = z.infer<typeof CreateServerSchema>;

export const LoginSchema = z.object({
  password: z.string().min(1).max(512),
});

export const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(512),
  newPassword: z.string().min(12).max(512),
});

export const ConsoleCommandSchema = z.object({
  command: z
    .string()
    .trim()
    .min(1)
    .max(1000)
    .refine((value) => !value.includes("\0")),
});

export const serverStates = [
  "running",
  "stopped",
  "starting",
  "unhealthy",
  "unknown",
] as const;
export type ServerState = (typeof serverStates)[number];

export interface ServerSummary {
  id: string;
  slug: string;
  config: ServerConfig;
  revision: number;
  appliedRevision: number;
  restartRequired: boolean;
  state: ServerState;
  health?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ServerStats {
  cpuPercent: number | null;
  memoryUsage: string | null;
  memoryPercent: number | null;
  players: string | null;
  uptime: string | null;
}

export interface AddonFile {
  name: string;
  size: number;
  modifiedAt: string;
  enabled: boolean;
}

export interface BackupFile {
  name: string;
  size: number;
  createdAt: string;
}

export interface Operation {
  id: string;
  serverId: string | null;
  kind: string;
  status: "queued" | "running" | "succeeded" | "failed";
  message: string | null;
  createdAt: string;
  updatedAt: string;
}

export const reservedEnvironmentKeys = new Set([
  "EULA",
  "TYPE",
  "VERSION",
  "SERVER_PORT",
  "RCON_PORT",
  "RCON_PASSWORD",
  "RCON_PASSWORD_FILE",
  "ENABLE_RCON",
  "INIT_MEMORY",
  "MAX_MEMORY",
  "MEMORY",
  "CUSTOM_SERVER_PROPERTIES",
]);

export function addonKind(type: ServerType): "mods" | "plugins" | null {
  if (type === "PAPER") return "plugins";
  if (type === "FABRIC" || type === "FORGE" || type === "NEOFORGE")
    return "mods";
  return null;
}

export function automaticJavaTag(version: string): string {
  const normalized = version.trim().toUpperCase();
  if (normalized === "LATEST" || normalized === "SNAPSHOT") return "stable";
  if (/^2[6-9](?:\.|$)/.test(normalized)) return "java25";
  const match = /^1\.(\d+)(?:\.(\d+))?/.exec(normalized);
  if (!match) return "stable";
  const minor = Number(match[1]);
  const patch = Number(match[2] ?? 0);
  if (minor > 20 || (minor === 20 && patch >= 5)) return "java21";
  if (minor >= 18) return "java17";
  if (minor === 17) return "java16";
  return "java8";
}
