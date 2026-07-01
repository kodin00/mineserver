import { CronExpressionParser } from "cron-parser";
import { ServerConfigSchema } from "@mineserver/shared";
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

  constructor(
    private readonly store: Store,
    private readonly docker: ComposeManager,
    private readonly jobs: JobRunner,
  ) {}

  start() {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), 30_000);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async tick() {
    if (this.checking) return;
    this.checking = true;
    try {
      const now = new Date();
      const minute = Math.floor(now.getTime() / 60_000) * 60_000;
      for (const row of this.store.listServers()) {
        const serverConfig = ServerConfigSchema.parse(
          JSON.parse(row.config_json),
        );
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
        this.lastRun.set(row.id, minute);
        const paths = instancePaths(config.instancesRoot, row.id);
        if (await pathExists(paths.backupMigrationMarker)) continue;
        const runtime = await this.docker.status(row.id, paths);
        if (runtime.state !== "running") continue;
        this.jobs.run(row.id, "scheduled-backup", () =>
          createBackup(row.id, paths, this.docker, serverConfig.backups),
        );
      }
    } finally {
      this.checking = false;
    }
  }
}
