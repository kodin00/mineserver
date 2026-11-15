import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServerConfigSchema } from "@mineserver/shared";
import { BackupScheduler } from "./backup-scheduler.js";

function setup(runExclusive: () => unknown) {
  const serverConfig = ServerConfigSchema.parse({
    name: "Test",
    backups: { enabled: true, cron: "* * * * *" },
  });
  const store = {
    listServers: () => [
      { id: "server-1", config_json: JSON.stringify(serverConfig) },
    ],
    pruneOperations: vi.fn(),
    pruneSessions: vi.fn(),
    pruneAddonShares: vi.fn(),
  };
  const docker = { status: async () => ({ state: "running" }) };
  const jobs = { runExclusive: vi.fn(runExclusive) };
  const scheduler = new BackupScheduler(
    store as never,
    docker as never,
    jobs as never,
  );
  const tick = () => (scheduler as any).tick() as Promise<void>;
  return { store, jobs, tick };
}

describe("BackupScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T04:00:10Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("retries a due backup after a 409 instead of consuming the minute", async () => {
    let busy = true;
    const { jobs, tick } = setup(() => {
      if (busy) throw Object.assign(new Error("busy"), { statusCode: 409 });
      return {};
    });
    await tick();
    expect(jobs.runExclusive).toHaveBeenCalledTimes(1);
    busy = false;
    await tick();
    expect(jobs.runExclusive).toHaveBeenCalledTimes(2);
    // Once queued, the same minute is not queued twice.
    await tick();
    expect(jobs.runExclusive).toHaveBeenCalledTimes(2);
  });

  it("prunes operations, sessions and share links periodically", async () => {
    const { store, tick } = setup(() => ({}));
    await tick();
    await tick();
    expect(store.pruneOperations).toHaveBeenCalledTimes(1);
    expect(store.pruneSessions).toHaveBeenCalledTimes(1);
    expect(store.pruneAddonShares).toHaveBeenCalledTimes(1);
  });
});
