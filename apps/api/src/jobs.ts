import { EventEmitter } from "node:events";
import type { Operation } from "@mineserver/shared";
import type { Store } from "./db.js";

export class JobRunner extends EventEmitter {
  constructor(private readonly store: Store) {
    super();
  }

  run(
    serverId: string | null,
    kind: string,
    task: () => Promise<unknown>,
  ): Operation {
    const now = new Date().toISOString();
    const operation: Operation = {
      id: crypto.randomUUID(),
      serverId,
      kind,
      status: "queued",
      message: null,
      createdAt: now,
      updatedAt: now,
    };
    this.store.insertOperation(operation);
    this.emit("operation", operation);
    void this.execute(operation, task);
    return operation;
  }

  private async execute(operation: Operation, task: () => Promise<unknown>) {
    this.store.updateOperation(operation.id, "running", null);
    this.emit("operation", {
      ...operation,
      status: "running",
      updatedAt: new Date().toISOString(),
    });
    try {
      const result = await task();
      // A task may return a human-readable summary of what it did; anything
      // else keeps the previous generic message.
      const message =
        typeof result === "string" && result.trim()
          ? result.slice(0, 4000)
          : "Completed";
      this.store.updateOperation(operation.id, "succeeded", message);
      this.emit("operation", {
        ...operation,
        status: "succeeded",
        message,
        updatedAt: new Date().toISOString(),
      });
    } catch (error: any) {
      const message = String(error?.message ?? error).slice(0, 4000);
      this.store.updateOperation(operation.id, "failed", message);
      this.emit("operation", {
        ...operation,
        status: "failed",
        message,
        updatedAt: new Date().toISOString(),
      });
    }
  }
}
