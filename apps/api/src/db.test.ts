import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { ServerConfigSchema } from "@mineserver/shared";
import { DatabaseSync } from "node:sqlite";
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

describe("schema upgrade from an existing panel database", () => {
  it("adds the new tables to a user_version=2 database without losing data", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mineserver-db-upgrade-"));
    roots.push(root);
    const file = path.join(root, "panel.sqlite");

    // Recreate the pre-marketplace schema exactly as it shipped: the tables an
    // existing deployment already has, at user_version=2, with real rows in it.
    const legacy = new DatabaseSync(file);
    legacy.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE administrator (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY,
        csrf_token TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE servers (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        config_json TEXT NOT NULL,
        applied_config_json TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        applied_revision INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE operations (
        id TEXT PRIMARY KEY,
        server_id TEXT REFERENCES servers(id) ON DELETE SET NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE addon_share_tokens (
        token_hash TEXT PRIMARY KEY,
        server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      PRAGMA user_version=2;
    `);
    legacy
      .prepare(
        `INSERT INTO servers(id,slug,config_json,applied_config_json,
           revision,applied_revision,created_at,updated_at)
         VALUES('legacy-1','legacy',?,?,3,3,'now','now')`,
      )
      .run(
        JSON.stringify(ServerConfigSchema.parse({ name: "Legacy" })),
        JSON.stringify(ServerConfigSchema.parse({ name: "Legacy" })),
      );
    legacy.close();

    // Opening it with the current Store must migrate in place.
    const store = new Store(file);
    const migrated = store.db.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    expect(migrated.user_version).toBeGreaterThanOrEqual(6);

    // The pre-existing row survived, revision counters intact.
    expect(store.getServer("legacy-1")).toMatchObject({
      slug: "legacy",
      revision: 3,
    });

    // Both new tables are usable straight away, with no manual step.
    expect(store.listAddonSources("legacy-1")).toEqual([]);
    store.recordAddonSource({
      server_id: "legacy-1",
      filename: "mod.jar",
      provider: "modrinth",
      target: "addons",
      project_type: "mod",
      level_name: null,
      project_id: "AABBCCDD",
      project_title: "Mod",
      version_id: "12345678",
      version_number: "1.0.0",
      sha512: "abc",
      installed_at: "now",
    });
    expect(store.listAddonSources("legacy-1")).toHaveLength(1);
    expect(store.getPanelSettings(true)).toMatchObject({
      modrinth_enabled: 1,
      modrinth_token: null,
    });
    store.db.close();
  });
});
