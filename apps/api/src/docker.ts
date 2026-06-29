import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { ServerState, ServerStats } from "@mineserver/shared";
import type { InstancePaths } from "./compose.js";
import { config } from "./config.js";
import { runCommand } from "./utils.js";

export interface RuntimeStatus {
  state: ServerState;
  health?: string;
}

export class ComposeManager {
  private args(id: string, paths: InstancePaths, rest: string[]): string[] {
    return [
      "compose",
      "--project-name",
      `mineserver_${id.replace(/-/g, "")}`,
      "--file",
      paths.compose,
      ...rest,
    ];
  }

  run(id: string, paths: InstancePaths, rest: string[], timeoutMs = 180_000) {
    return runCommand(config.DOCKER_BIN, this.args(id, paths, rest), {
      cwd: paths.root,
      timeoutMs,
    });
  }

  up(id: string, paths: InstancePaths, forceRecreate = false) {
    return this.run(
      id,
      paths,
      [
        "up",
        "-d",
        "--remove-orphans",
        ...(forceRecreate ? ["--force-recreate"] : []),
      ],
      10 * 60_000,
    );
  }

  stop(id: string, paths: InstancePaths) {
    return this.run(id, paths, ["stop", "-t", "120"], 180_000);
  }

  down(id: string, paths: InstancePaths) {
    return this.run(id, paths, ["down", "--remove-orphans"], 180_000);
  }

  restart(id: string, paths: InstancePaths) {
    return this.run(id, paths, ["restart", "-t", "120", "mc"], 180_000);
  }

  async pull(id: string, paths: InstancePaths) {
    await this.run(id, paths, ["pull"], 15 * 60_000);
    return this.up(id, paths);
  }

  console(id: string, paths: InstancePaths, command: string) {
    return this.run(
      id,
      paths,
      ["exec", "-T", "mc", "rcon-cli", command],
      30_000,
    );
  }

  backupNow(id: string, paths: InstancePaths) {
    return this.run(
      id,
      paths,
      ["exec", "-T", "backups", "backup", "now"],
      60 * 60_000,
    );
  }

  logs(id: string, paths: InstancePaths, tail = 200) {
    return this.run(
      id,
      paths,
      ["logs", "--no-color", "--tail", String(tail), "mc"],
      30_000,
    );
  }

  followLogs(id: string, paths: InstancePaths): ChildProcessWithoutNullStreams {
    return spawn(
      config.DOCKER_BIN,
      this.args(id, paths, [
        "logs",
        "--follow",
        "--no-color",
        "--tail",
        "100",
        "mc",
      ]),
      { cwd: paths.root, shell: false, stdio: ["pipe", "pipe", "pipe"] },
    );
  }

  async status(id: string, paths: InstancePaths): Promise<RuntimeStatus> {
    try {
      const result = await this.run(
        id,
        paths,
        ["ps", "--format", "json", "mc"],
        10_000,
      );
      if (!result.stdout.trim()) return { state: "stopped" };
      const raw = result.stdout.trim();
      let value: any;
      try {
        const parsed = JSON.parse(raw);
        value = Array.isArray(parsed) ? (parsed[0] ?? {}) : parsed;
      } catch {
        value =
          raw
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line))[0] ?? {};
      }
      const rawState = String(value.State ?? "").toLowerCase();
      const health = String(value.Health ?? "").toLowerCase() || undefined;
      if (rawState === "running" && health === "unhealthy")
        return { state: "unhealthy", health };
      if (rawState === "running")
        return { state: "running", ...(health ? { health } : {}) };
      if (rawState === "restarting" || rawState === "created")
        return { state: "starting", ...(health ? { health } : {}) };
      return {
        state: rawState === "exited" ? "stopped" : "unknown",
        ...(health ? { health } : {}),
      };
    } catch (error: any) {
      if (
        /no configuration file|not found|no such file/i.test(
          String(error?.message),
        )
      ) {
        return { state: "stopped" };
      }
      return { state: "unknown" };
    }
  }

  async stats(id: string, paths: InstancePaths): Promise<ServerStats> {
    try {
      const container = await this.run(id, paths, ["ps", "-q", "mc"], 10_000);
      const containerId = container.stdout.trim();
      if (!containerId)
        return {
          cpuPercent: null,
          memoryUsage: null,
          memoryPercent: null,
          players: null,
          uptime: null,
        };
      const stats = await runCommand(
        config.DOCKER_BIN,
        ["stats", "--no-stream", "--format", "{{json .}}", containerId],
        { timeoutMs: 10_000 },
      );
      const value = JSON.parse(stats.stdout.trim());
      let players: string | null = null;
      try {
        players = (await this.console(id, paths, "list")).stdout.trim() || null;
      } catch {
        // The container can be running while RCON is still starting.
      }
      return {
        cpuPercent: Number.parseFloat(String(value.CPUPerc ?? "")) || null,
        memoryUsage: value.MemUsage ?? null,
        memoryPercent: Number.parseFloat(String(value.MemPerc ?? "")) || null,
        players,
        uptime: value.PIDs ? `${value.PIDs} processes` : null,
      };
    } catch {
      return {
        cpuPercent: null,
        memoryUsage: null,
        memoryPercent: null,
        players: null,
        uptime: null,
      };
    }
  }
}
