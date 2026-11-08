import { mkdir, readFile, writeFile } from "node:fs/promises";
import { hash } from "@node-rs/argon2";
import { composeUserAgent } from "@mineserver/shared";
import { instancePaths, writeCompose } from "./compose.js";
import { config } from "./config.js";
import { Store } from "./db.js";
import { ComposeManager } from "./docker.js";
import { JobRunner } from "./jobs.js";
import { ModrinthClient } from "./modrinth.js";
import { rowConfig } from "./helpers.js";
import { pathExists } from "./utils.js";
import type { AppContext } from "./app.js";

export async function createContext(): Promise<AppContext> {
  await Promise.all([
    mkdir(config.DATA_ROOT, { recursive: true }),
    mkdir(config.instancesRoot, { recursive: true }),
    mkdir(config.tempRoot, { recursive: true }),
  ]);
  const store = new Store(config.databasePath);
  if (!store.getAdmin()) store.createAdmin(await hash(config.ADMIN_PASSWORD));
  store.pruneSessions();
  store.pruneAddonShares();
  const docker = new ComposeManager();
  for (const row of store.listServers()) {
    const paths = instancePaths(config.instancesRoot, row.id);
    const composeContents = (await pathExists(paths.compose))
      ? await readFile(paths.compose, "utf8")
      : "";
    const needsBackupMigration = composeContents.includes("itzg/mc-backup");
    const needsRestartPolicyMigration = composeContents.includes(
      "restart: unless-stopped",
    );
    if (needsBackupMigration) {
      store.touchServerRevision(row.id);
      await writeFile(paths.backupMigrationMarker, "apply required\n", {
        mode: 0o600,
      });
    }
    if (needsBackupMigration || needsRestartPolicyMigration) {
      await writeCompose(row.id, rowConfig(row), paths);
    }
    if (needsRestartPolicyMigration) {
      await docker.enforceRestartLimit(row.id, paths).catch((error) => {
        console.error(
          `[mineserver] Could not update restart policy for ${row.id}:`,
          error,
        );
      });
    }
  }
  const modrinth = new ModrinthClient({
    credentials: () => {
      const row = store.getPanelSettings(config.MODRINTH_ENABLED);
      return {
        userAgent: composeUserAgent(
          config.MODRINTH_USER_AGENT,
          row.modrinth_contact,
        ),
        token: row.modrinth_token,
      };
    },
    baseUrl: config.MODRINTH_BASE_URL,
    cdnHost: config.MODRINTH_CDN_HOST,
    requestsPerMinute: config.MODRINTH_REQUESTS_PER_MINUTE,
    apiTimeoutMs: config.MODRINTH_API_TIMEOUT_MS,
    downloadTimeoutMs: config.MODRINTH_DOWNLOAD_TIMEOUT_MS,
    maxFileBytes: config.MODRINTH_MAX_FILE_BYTES,
  });
  return { store, docker, jobs: new JobRunner(store), modrinth };
}
