import path from "node:path";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import type { BackupFile } from "@mineserver/shared";
import type { InstancePaths } from "./compose.js";
import type { ComposeManager } from "./docker.js";
import { pathExists, runCommand, safeFilename } from "./utils.js";

export async function listBackups(directory: string): Promise<BackupFile[]> {
  await mkdir(directory, { recursive: true });
  const entries = await readdir(directory, { withFileTypes: true });
  return Promise.all(
    entries
      .filter(
        (entry) => entry.isFile() && /\.(?:tgz|tar\.gz)$/i.test(entry.name),
      )
      .map(async (entry) => {
        const info = await stat(path.join(directory, entry.name));
        return {
          name: entry.name,
          size: info.size,
          createdAt: info.mtime.toISOString(),
        };
      }),
  ).then((files) =>
    files.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  );
}

export async function removeBackup(directory: string, filename: string) {
  const safe = safeFilename(filename);
  if (!/\.(?:tgz|tar\.gz)$/i.test(safe)) throw new Error("Invalid backup file");
  const target = path.join(directory, safe);
  if (!(await pathExists(target))) throw new Error("Backup not found");
  await rm(target);
}

export async function restoreBackup(
  id: string,
  filename: string,
  paths: InstancePaths,
  docker: ComposeManager,
) {
  const safe = safeFilename(filename);
  const backup = path.join(paths.backups, safe);
  if (!(await pathExists(backup))) throw new Error("Backup not found");
  const state = await docker.status(id, paths);
  if (state.state !== "stopped")
    throw new Error("Stop the server before restoring a backup");

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safety = path.join(paths.backups, `pre-restore-${stamp}.tgz`);
  const staging = path.join(paths.root, `.restore-${crypto.randomUUID()}`);
  const rollback = path.join(paths.root, `.rollback-${stamp}`);
  await mkdir(staging, { recursive: false });

  try {
    await runCommand("tar", ["-czf", safety, "-C", paths.data, "."], {
      timeoutMs: 60 * 60_000,
    });
    await runCommand(
      "tar",
      ["-xzf", backup, "-C", staging, "--no-same-owner"],
      {
        timeoutMs: 60 * 60_000,
      },
    );
    await docker.down(id, paths).catch(() => undefined);
    await rename(paths.data, rollback);
    await rename(staging, paths.data);
    try {
      await docker.up(id, paths);
      const deadline = Date.now() + 180_000;
      let healthy = false;
      while (Date.now() < deadline) {
        const current = await docker.status(id, paths);
        if (current.state === "running" && current.health !== "starting") {
          healthy = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
      if (!healthy) throw new Error("Restored server did not become healthy");
      await rm(rollback, { recursive: true, force: true });
    } catch (error) {
      await docker.down(id, paths).catch(() => undefined);
      await rm(paths.data, { recursive: true, force: true });
      await rename(rollback, paths.data);
      await docker.up(id, paths).catch(() => undefined);
      throw error;
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
