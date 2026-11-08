import { z } from "zod";

export * from "./server-type.js";
import { ServerTypeSchema, type ServerType } from "./server-type.js";

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
const serverIconUrlSchema = z
  .string()
  .trim()
  .url("Use a valid URL such as https://example.com/server-icon.png")
  .max(500)
  .refine((value) => /^https?:\/\//i.test(value), {
    message: "Server icon URL must start with http:// or https://",
  });

export const BackupSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  cron: z.string().trim().min(5).max(100).default("0 4 * * *"),
  retainDays: z.coerce.number().int().min(1).max(3650).default(7),
  retainCount: z.coerce.number().int().min(1).max(1000).default(14),
});
export type BackupSettings = z.infer<typeof BackupSettingsSchema>;

export const AutoSleepSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  idleMinutes: z.coerce
    .number()
    .int()
    .min(1)
    .max(7 * 24 * 60)
    .default(10),
});
export type AutoSleepSettings = z.infer<typeof AutoSleepSettingsSchema>;

export const ServerConfigSchema = z
  .object({
    name: z.string().trim().min(1).max(64),
    version: z.string().trim().min(1).max(40).default("LATEST"),
    type: ServerTypeSchema.default("PAPER"),
    port: z.coerce.number().int().min(1024).max(65535).default(25565),
    serverIconUrl: serverIconUrlSchema.nullable().default(null),
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
    autoSleep: AutoSleepSettingsSchema.default({
      enabled: false,
      idleMinutes: 10,
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

export const AddonToggleSchema = z.object({
  enabled: z.boolean(),
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

export const PlayerNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(16)
  .regex(/^[A-Za-z0-9_]+$/, "Use a valid Minecraft player name");

export const PlayerReasonSchema = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .refine(
    (value) => !/[\0-\x1f\x7f]/.test(value),
    "Reasons cannot contain control characters",
  );

export const PlayerActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("kick"),
    player: PlayerNameSchema,
    reason: PlayerReasonSchema.optional(),
  }),
  z.object({
    action: z.literal("ban"),
    player: PlayerNameSchema,
    reason: PlayerReasonSchema.optional(),
  }),
  z.object({ action: z.literal("pardon"), player: PlayerNameSchema }),
  z.object({ action: z.literal("whitelist-add"), player: PlayerNameSchema }),
  z.object({ action: z.literal("whitelist-remove"), player: PlayerNameSchema }),
  z.object({ action: z.literal("op"), player: PlayerNameSchema }),
  z.object({ action: z.literal("deop"), player: PlayerNameSchema }),
]);
export type PlayerAction = z.infer<typeof PlayerActionSchema>;

export const WhitelistActionSchema = z.object({
  action: z.enum(["on", "off", "reload"]),
});
export type WhitelistAction = z.infer<typeof WhitelistActionSchema>;

export interface OnlinePlayers {
  online: number;
  max: number;
  players: Array<{ name: string }>;
  fetchedAt: string;
}

export interface PlayerActionResult {
  ok: true;
  output: string;
  players: OnlinePlayers | null;
}

const relativeServerPathSchema = z
  .string()
  .min(0)
  .max(4096)
  .refine((value) => !value.includes("\0"), "Invalid file path")
  .refine((value) => !value.startsWith("/"), "Use a relative file path")
  .refine(
    (value) => !value.replace(/\\/g, "/").split("/").includes(".."),
    "Invalid file path",
  );

const serverFileNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine(
    (value) =>
      value !== "." &&
      value !== ".." &&
      !value.includes("/") &&
      !value.includes("\\") &&
      !/[\0-\x1f\x7f]/.test(value),
    "Invalid file name",
  );

export const ServerFileCreateSchema = z.object({
  parentPath: relativeServerPathSchema.default(""),
  name: serverFileNameSchema,
  type: z.enum(["file", "directory"]),
});
export type ServerFileCreateInput = z.infer<typeof ServerFileCreateSchema>;

const nonemptyRelativeServerPathSchema = relativeServerPathSchema.refine(
  (value) => value.length > 0,
  "File path is required",
);

export const ServerFileMoveSchema = z
  .object({
    path: nonemptyRelativeServerPathSchema,
    destinationPath: nonemptyRelativeServerPathSchema,
  })
  .refine((value) => value.path !== value.destinationPath, {
    message: "Source and destination must differ",
    path: ["destinationPath"],
  });
export type ServerFileMoveInput = z.infer<typeof ServerFileMoveSchema>;

export const ServerFileDeleteSchema = z.object({
  path: nonemptyRelativeServerPathSchema,
  expectedModifiedAt: z.string().datetime().optional(),
});
export type ServerFileDeleteInput = z.infer<typeof ServerFileDeleteSchema>;

export const WorldImportSchema = z.object({
  acknowledgeLevelName: z.string().trim().min(1).max(64),
  overwrite: z.literal(true),
});
export type WorldImportInput = z.infer<typeof WorldImportSchema>;

export interface WorldInfo {
  levelName: string;
  exists: boolean;
  size: number | null;
  modifiedAt: string | null;
  serverState: ServerState;
  canImport: boolean;
}

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
  containerExists: boolean;
  wakeProxyRunning?: boolean;
  runtimeError?: {
    message: string;
    exitCode: number | null;
    restartCount: number;
    occurredAt: string | null;
  };
  createdAt: string;
  updatedAt: string;
}

export interface ServerStats {
  cpuPercent: number | null;
  memoryUsage: string | null;
  memoryPercent: number | null;
  players: OnlinePlayers | null;
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

export interface ServerFileEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size: number | null;
  modifiedAt: string;
  editable: boolean;
}

export interface ServerFileDocument {
  path: string;
  content: string;
  size: number;
  modifiedAt: string;
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
  "ICON",
  "OVERRIDE_ICON",
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

export * from "./modrinth.js";
