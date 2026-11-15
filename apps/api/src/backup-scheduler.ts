import { CronExpressionParser } from "cron-parser";
import { ServerConfigSchema, type ServerConfig } from "@mineserver/shared";
import { createBackup } from "./backups.js";
import { instancePaths } from "./compose.js";
import { config } from "./config.js";
import type { Store } from "./db.js";
import type { ComposeManager } from "./docker.js";
import type { JobRunner } from "./jobs.js";
import { pathExists } from "./utils.js";

export class BackupScheduler {
  private timer: NodeJS.Timeout | undefined;
  private checking = false;
  private readonly lastRun = new Map<string, number>();
  private lastMaintenance = 0;

  constructor(
    private readonly store: Store,
    private readonly docker: ComposeManager,
    private readonly jobs: JobRunner,
  ) {}

  start() {
    if (this.timer) return;
    void this.tick().catch((error) => {
      console.error("[mineserver] Backup scheduler tick failed:", error);
    });
    this.timer = setInterval(
      () =>
        void this.tick().catch((error) => {
          console.error("[mineserver] Backup scheduler tick failed:", error);
        }),
      30_000,
    );
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * Operations, expired sessions and spent share links are otherwise only
   * pruned at startup (or never), so a long-running panel would grow forever.
   */
  private maintain() {
    if (Date.now() - this.lastMaintenance < 60 * 60_000) return;
    this.lastMaintenance = Date.now();
    try {
      this.store.pruneOperations();
      this.store.pruneSessions();
      this.store.pruneAddonShares();
    } catch (error) {
      console.error("[mineserver] Store maintenance failed:", error);
    }
  }

  private async tick() {
    if (this.checking) return;
    this.checking = true;
    try {
      this.maintain();
      const now = new Date();
      const minute = Math.floor(now.getTime() / 60_000) * 60_000;
      for (const row of this.store.listServers()) {
        let serverConfig: ServerConfig;
        try {
          serverConfig = ServerConfigSchema.parse(JSON.parse(row.config_json));
        } catch (error) {
          console.error(
            `[mineserver] Skipping server ${row.id} in backup scheduler: unparseable config`,
            error,
          );
          continue;
        }
        if (!serverConfig.backups.enabled) continue;
        let scheduled: number;
        try {
          scheduled = CronExpressionParser.parse(serverConfig.backups.cron, {
            currentDate: new Date(minute + 59_999),
            tz: config.TZ,
          })
            .prev()
            .getTime();
        } catch {
          continue;
        }
        if (
          scheduled < minute ||
          scheduled >= minute + 60_000 ||
          this.lastRun.get(row.id) === minute
        ) {
          continue;
        }
        const paths = instancePaths(config.instancesRoot, row.id);
        if (await pathExists(paths.backupMigrationMarker)) continue;
        const runtime = await this.docker.status(row.id, paths);
        if (runtime.state !== "running") continue;
        // Mark only after the backup was actually queued: a server that is not
        // running, or is busy with another change (409), during its scheduled
        // minute must keep the minute claimable by the next 30-second tick
        // instead of silently skipping the backup.
        try {
          this.jobs.runExclusive(row.id, "scheduled-backup", () =>
            createBackup(row.id, paths, this.docker, serverConfig.backups),
          );
          this.lastRun.set(row.id, minute);
        } catch (error: any) {
          if (error?.statusCode !== 409) throw error;
        }
      }
    } finally {
      this.checking = false;
    }
  }
}
