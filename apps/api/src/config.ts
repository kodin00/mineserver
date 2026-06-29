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
  MAX_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(2 * 1024 * 1024 * 1024),
  MAX_ZIP_EXPANDED_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(4 * 1024 * 1024 * 1024),
  MAX_ZIP_FILES: z.coerce.number().int().positive().default(500),
  DOCKER_BIN: z.string().default("docker"),
  TZ: z.string().default("Asia/Jakarta"),
});

const parsed = EnvSchema.parse(process.env);

export const config = {
  ...parsed,
  databasePath: path.join(parsed.DATA_ROOT, "panel.sqlite"),
  instancesRoot: path.join(parsed.DATA_ROOT, "instances"),
  tempRoot: path.join(parsed.DATA_ROOT, ".tmp"),
};
