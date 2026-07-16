import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { ServerConfigSchema } from "@mineserver/shared";
import { Store } from "./db.js";

const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "mineserver-db-"));
  roots.push(root);
  const store = new Store(path.join(root, "panel.sqlite"));
  store.insertServer(
    "server-1",
    "test-server",
    ServerConfigSchema.parse({ name: "Test server", type: "FABRIC" }),
  );
  return store;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("one-time add-on shares", () => {
  it("claims a valid token exactly once", async () => {
    const store = await fixture();
    store.createAddonShare(
      "token-hash",
      "server-1",
      new Date(Date.now() + 60_000).toISOString(),
    );

    expect(store.claimAddonShare("token-hash")).toEqual({
      server_id: "server-1",
    });
    expect(store.claimAddonShare("token-hash")).toBeUndefined();
    store.db.close();
  });

  it("does not claim expired tokens", async () => {
    const store = await fixture();
    store.createAddonShare(
      "expired-hash",
      "server-1",
      new Date(Date.now() - 60_000).toISOString(),
    );

    expect(store.claimAddonShare("expired-hash")).toBeUndefined();
    store.pruneAddonShares();
    expect(
      store.db
        .prepare(
          "SELECT COUNT(*) AS count FROM addon_share_tokens WHERE token_hash=?",
        )
        .get("expired-hash"),
    ).toEqual({ count: 0 });
    store.db.close();
  });
});
