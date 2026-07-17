import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { ServerConfigSchema } from "@mineserver/shared";
import { environmentFor, instancePaths, renderCompose } from "./compose.js";
import { ComposeManager } from "./docker.js";

const base = ServerConfigSchema.parse({
  name: "Test",
  type: "PAPER",
  port: 25565,
});

describe("compose generation", () => {
  it("keeps reserved environment values controlled by the panel", () => {
    const environment = environmentFor({
      ...base,
      advancedEnv: { EULA: "FALSE", SPAWN_PROTECTION: "0" },
    });
    expect(environment.EULA).toBe("TRUE");
    expect(environment.SPAWN_PROTECTION).toBe("0");
  });

  it("mounts Paper uploads as plugins and does not expose RCON", () => {
    const paths = instancePaths("/opt/mineserver/instances", "abc");
    const output = renderCompose("abc", base, paths);
    expect(output).toContain(`${path.join(paths.root, "addons")}:/plugins:ro`);
    expect(output).not.toContain("25575:");
    expect(output).toContain("RCON_PASSWORD_FILE");
    expect(output).toContain("mem_limit: 5120M");
    expect(output).not.toContain("itzg/mc-backup");
  });

  it("passes server icon URLs to the Minecraft container", () => {
    const environment = environmentFor({
      ...base,
      serverIconUrl: "https://example.com/server-icon.png",
    });
    expect(environment.ICON).toBe("https://example.com/server-icon.png");
    expect(environment.OVERRIDE_ICON).toBe("TRUE");
  });

  it("retries a failed container only once", () => {
    const paths = instancePaths("/opt/mineserver/instances", "abc");
    const document = YAML.parse(renderCompose("abc", base, paths));
    expect(document.services.mc.restart).toBe("on-failure:1");
  });

  it("puts a lightweight Minecraft proxy on the host port when auto-sleep is enabled", () => {
    const paths = instancePaths("/opt/mineserver/instances", "abc");
    const document = YAML.parse(
      renderCompose(
        "abc",
        {
          ...base,
          autoSleep: { enabled: true, idleMinutes: 15 },
        },
        paths,
      ),
    );
    expect(document.services.mc.ports).toBeUndefined();
    expect(document.services.mc.restart).toBe("no");
    expect(document.services.mc.labels["lazymc.enabled"]).toBe("true");
    expect(document.services.mc.labels["lazymc.time.sleep_after"]).toBe("900");
    expect(document.services.mc.labels["lazymc.join.methods"]).toBe(
      "hold,kick",
    );
    expect(document.services.sleep_proxy.ports).toEqual(["25565:25565"]);
    expect(document.services.sleep_proxy.volumes).toContain(
      "/var/run/docker.sock:/var/run/docker.sock:ro",
    );
    expect(document.networks.minecraft.ipam.config[0].subnet).toMatch(
      /^10\.(?:\d{1,3}\.){2}\d+\/29$/,
    );
  });

  it("carries whitelist and Forge handshake rules into the wake proxy", () => {
    const paths = instancePaths("/opt/mineserver/instances", "abc");
    const document = YAML.parse(
      renderCompose(
        "abc",
        {
          ...base,
          type: "FORGE",
          whitelist: ["Alex"],
          autoSleep: { enabled: true, idleMinutes: 10 },
        },
        paths,
      ),
    );
    expect(document.services.mc.labels["lazymc.server.forge"]).toBe("true");
    expect(document.services.mc.labels["lazymc.server.wake_whitelist"]).toBe(
      "true",
    );
    expect(document.services.mc.labels["lazymc.server.block_banned_ips"]).toBe(
      "true",
    );
  });
});

describe("compose lifecycle commands", () => {
  class RecordingComposeManager extends ComposeManager {
    calls: string[][] = [];

    override run(
      _id: string,
      _paths: ReturnType<typeof instancePaths>,
      rest: string[],
    ) {
      this.calls.push(rest);
      return Promise.resolve({ stdout: "", stderr: "", code: 0 });
    }
  }

  it("runs an existing container without rebuilding or recreating it", async () => {
    const docker = new RecordingComposeManager();
    await docker.startExisting(
      "abc",
      instancePaths("/opt/mineserver/instances", "abc"),
    );
    expect(docker.calls[0]).toEqual([
      "up",
      "-d",
      "--no-recreate",
      "--no-build",
    ]);
  });

  it("rebuilds by force-recreating without invoking an image build", async () => {
    const docker = new RecordingComposeManager();
    await docker.rebuild(
      "abc",
      instancePaths("/opt/mineserver/instances", "abc"),
    );
    expect(docker.calls[0]).toContain("--force-recreate");
    expect(docker.calls[0]).toContain("--no-build");
  });

  it("reports a stopped crash with its exit code and restart count", async () => {
    class FailedContainerManager extends ComposeManager {
      override run() {
        return Promise.resolve({
          stdout: JSON.stringify({
            ID: "container-id",
            State: "exited",
            ExitCode: 1,
          }),
          stderr: "",
          code: 0,
        });
      }

      protected override async inspect() {
        return {
          State: {
            Status: "exited",
            ExitCode: 1,
            Error: "",
            FinishedAt: "2026-07-16T12:00:00Z",
          },
          RestartCount: 1,
        };
      }
    }

    const status = await new FailedContainerManager().status(
      "abc",
      instancePaths("/opt/mineserver/instances", "abc"),
    );
    expect(status).toMatchObject({
      state: "stopped",
      exists: true,
      runtimeError: {
        exitCode: 1,
        restartCount: 1,
        occurredAt: "2026-07-16T12:00:00Z",
      },
    });
  });

  it("distinguishes an active wake proxy from a fully stopped project", async () => {
    class SleepingServerManager extends ComposeManager {
      override run(
        _id: string,
        _paths: ReturnType<typeof instancePaths>,
        rest: string[],
      ) {
        const service = rest.at(-1);
        return Promise.resolve({
          stdout:
            service === "sleep_proxy"
              ? JSON.stringify({ State: "running" })
              : JSON.stringify({
                  ID: "container-id",
                  State: "exited",
                  ExitCode: 0,
                }),
          stderr: "",
          code: 0,
        });
      }

      protected override async inspect() {
        return { State: { Status: "exited", ExitCode: 0 }, RestartCount: 0 };
      }
    }

    const status = await new SleepingServerManager().status(
      "abc",
      instancePaths("/opt/mineserver/instances", "abc"),
      true,
    );
    expect(status).toMatchObject({
      state: "stopped",
      exists: true,
      wakeProxyRunning: true,
    });
  });

  it("reads a timestamped bounded Docker log tail", async () => {
    const docker = new RecordingComposeManager();
    await docker.logs(
      "abc",
      instancePaths("/opt/mineserver/instances", "abc"),
      1000,
    );
    expect(docker.calls[0]).toEqual([
      "logs",
      "--no-color",
      "--timestamps",
      "--tail",
      "1000",
      "mc",
    ]);
  });
});
