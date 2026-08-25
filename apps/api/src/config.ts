import path from "node:path";
import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  DATA_ROOT: z.string().default(path.resolve(process.cwd(), "runtime")),
  ADMIN_PASSWORD: z.string().min(12).default("change-me-now-please"),
  SESSION_TTL_HOURS: z.coerce.number().positive().default(24),
  COOKIE_SECURE: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
  ADDON_SHARE_TTL_MINUTES: z.coerce
    .number()
    .int()
    .min(1)
    .max(7 * 24 * 60)
    .default(60),
  PUBLIC_DOWNLOAD_RATE_LIMIT: z.coerce.number().int().positive().default(10),
  MAX_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(2 * 1024 * 1024 * 1024),
  MAX_UPLOAD_FILES: z.coerce.number().int().min(1).max(1000).default(100),
  MAX_ZIP_EXPANDED_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(4 * 1024 * 1024 * 1024),
  MAX_ZIP_FILES: z.coerce.number().int().positive().default(500),
  MAX_EDIT_FILE_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(1024 * 1024),
  DOCKER_BIN: z.string().default("docker"),
  MODRINTH_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  MODRINTH_BASE_URL: z.string().url().default("https://api.modrinth.com/v2"),
  MODRINTH_CDN_HOST: z.string().min(1).default("cdn.modrinth.com"),
  // Modrinth requires a uniquely identifying User-Agent and blocks generic
  // HTTP client strings. Bump the version here with releases.
  MODRINTH_USER_AGENT: z
    .string()
    .min(8)
    .refine(
      (value) => !/mozilla|axios|node-fetch|undici|curl|okhttp/i.test(value),
      "Use a project-specific User-Agent, not a generic client string",
    )
    .default("kodin00/mineserver-panel/0.1.0 (github.com/kodin00/mineserver)"),
  // Modrinth allows 300 requests per minute per IP. Staying well under it
  // leaves room for bursts and for anything else sharing this egress address.
  MODRINTH_REQUESTS_PER_MINUTE: z.coerce
    .number()
    .int()
    .min(1)
    .max(300)
    .default(120),
  MODRINTH_API_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(60_000)
    .default(10_000),
  MODRINTH_DOWNLOAD_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(5_000)
    .max(600_000)
    .default(120_000),
  MODRINTH_MAX_FILE_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(512 * 1024 * 1024),
  // Datapacks are stored as intact ZIPs and never expanded by the panel, so
  // this only guards against an absurd archive. Real packs are large: Terralith
  // alone holds a little over 2000 files, far beyond MAX_ZIP_FILES.
  MODRINTH_MAX_DATAPACK_FILES: z.coerce
    .number()
    .int()
    .positive()
    .default(20_000),
  TZ: z.string().default("Asia/Jakarta"),
});

const parsed = EnvSchema.parse(process.env);

export const config = {
  ...parsed,
  databasePath: path.join(parsed.DATA_ROOT, "panel.sqlite"),
  instancesRoot: path.join(parsed.DATA_ROOT, "instances"),
  tempRoot: path.join(parsed.DATA_ROOT, ".tmp"),
};
