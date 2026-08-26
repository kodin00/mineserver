import { EventEmitter } from "node:events";
import type { Operation } from "@mineserver/shared";
import type { Store } from "./db.js";

interface ServerMutation {
  kind: string;
  token: symbol;
}

export interface ServerMutationLease {
  release(): void;
}

export class ServerMutationCoordinator {
  private readonly active = new Map<string, ServerMutation>();

  current(serverId: string): string | null {
    return this.active.get(serverId)?.kind ?? null;
  }

  assertAvailable(serverId: string) {
    const kind = this.current(serverId);
    if (kind) {
      throw Object.assign(
        new Error(`Another server change is already running (${kind})`),
        { statusCode: 409 },
      );
    }
  }

  acquire(serverId: string, kind: string): ServerMutationLease {
    this.assertAvailable(serverId);
    const token = Symbol(kind);
    this.active.set(serverId, { kind, token });
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        if (this.active.get(serverId)?.token === token) {
          this.active.delete(serverId);
        }
      },
    };
  }

  async runExclusive<T>(
    serverId: string,
    kind: string,
    task: () => Promise<T>,
  ): Promise<T> {
    const lease = this.acquire(serverId, kind);
    try {
      return await task();
    } finally {
      lease.release();
    }
  }
}

export class JobRunner extends EventEmitter {
  readonly mutations = new ServerMutationCoordinator();

  constructor(private readonly store: Store) {
    super();
  }

  run(
    serverId: string | null,
    kind: string,
    task: () => Promise<unknown>,
  ): Operation {
    return this.createOperation(serverId, kind, task);
  }

  runExclusive(
    serverId: string,
    kind: string,
    task: () => Promise<unknown>,
  ): Operation {
    const lease = this.mutations.acquire(serverId, kind);
    try {
      return this.createOperation(serverId, kind, async () => {
        try {
          return await task();
        } finally {
          lease.release();
        }
      });
    } catch (error) {
      lease.release();
      throw error;
    }
  }

  private createOperation(
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
