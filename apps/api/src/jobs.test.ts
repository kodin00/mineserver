import { describe, expect, it } from "vitest";
import type { Operation } from "@mineserver/shared";
import { JobRunner, ServerMutationCoordinator } from "./jobs.js";

describe("ServerMutationCoordinator", () => {
  it("rejects overlapping changes on one server and permits another server", async () => {
    const coordinator = new ServerMutationCoordinator();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = coordinator.runExclusive(
      "one",
      "world-import",
      () => blocked,
    );

    expect(coordinator.current("one")).toBe("world-import");
    expect(() => coordinator.assertAvailable("one")).toThrow(/world-import/);
    await expect(
      coordinator.runExclusive("one", "file-delete", async () => undefined),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      coordinator.runExclusive("two", "file-delete", async () => "ok"),
    ).resolves.toBe("ok");

    release();
    await first;
    expect(coordinator.current("one")).toBeNull();
  });

  it("always releases the server after a failed change", async () => {
    const coordinator = new ServerMutationCoordinator();
    await expect(
      coordinator.runExclusive("one", "marketplace-update", async () => {
        throw new Error("failed");
      }),
    ).rejects.toThrow("failed");
    expect(coordinator.current("one")).toBeNull();
    await expect(
      coordinator.runExclusive("one", "file-upload", async () => "done"),
    ).resolves.toBe("done");
  });
});

function jobStore() {
  const operations: Operation[] = [];
  return {
    operations,
    store: {
      insertOperation(operation: Operation) {
        operations.push(operation);
      },
      updateOperation(
        id: string,
        status: Operation["status"],
        message: string | null,
      ) {
        const operation = operations.find((item) => item.id === id)!;
        operation.status = status;
        operation.message = message;
        operation.updatedAt = new Date().toISOString();
      },
    },
  };
}

describe("JobRunner exclusive operations", () => {
  it("reserves before returning and does not insert a rejected operation", async () => {
    const { store, operations } = jobStore();
    const jobs = new JobRunner(store as never);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });

    jobs.runExclusive("one", "restore", () => blocked);
    expect(jobs.mutations.current("one")).toBe("restore");
    expect(() =>
      jobs.runExclusive("one", "file-delete", async () => undefined),
    ).toThrow(/restore/);
    expect(operations).toHaveLength(1);

    jobs.runExclusive("two", "file-delete", async () => "done");
    await expect.poll(() => jobs.mutations.current("two")).toBeNull();
    release();
    await expect.poll(() => jobs.mutations.current("one")).toBeNull();
  });

  it("releases after a failed operation", async () => {
    const { store, operations } = jobStore();
    const jobs = new JobRunner(store as never);
    jobs.runExclusive("one", "restore", async () => {
      throw new Error("failed");
    });

    await expect.poll(() => jobs.mutations.current("one")).toBeNull();
    expect(operations[0]).toMatchObject({
      status: "failed",
      message: "failed",
    });
    expect(() =>
      jobs.runExclusive("one", "file-write", async () => "done"),
    ).not.toThrow();
  });
});
