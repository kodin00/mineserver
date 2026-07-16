import { DatabaseSync } from "node:sqlite";
import type { Operation, ServerConfig } from "@mineserver/shared";

export interface ServerRow {
  id: string;
  slug: string;
  config_json: string;
  applied_config_json: string;
  revision: number;
  applied_revision: number;
  created_at: string;
  updated_at: string;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
    );
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS administrator (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        csrf_token TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS servers (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        config_json TEXT NOT NULL,
        applied_config_json TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        applied_revision INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS operations (
        id TEXT PRIMARY KEY,
        server_id TEXT REFERENCES servers(id) ON DELETE SET NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS addon_share_tokens (
        token_hash TEXT PRIMARY KEY,
        server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_operations_server_created
        ON operations(server_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_addon_share_tokens_expires
        ON addon_share_tokens(expires_at);
      PRAGMA user_version=2;
    `);
  }

  getAdmin(): { password_hash: string } | undefined {
    return this.db
      .prepare("SELECT password_hash FROM administrator WHERE id=1")
      .get() as { password_hash: string } | undefined;
  }

  createAdmin(passwordHash: string) {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "INSERT OR IGNORE INTO administrator(id,password_hash,created_at,updated_at) VALUES(1,?,?,?)",
      )
      .run(passwordHash, now, now);
  }

  updatePassword(passwordHash: string) {
    this.db
      .prepare(
        "UPDATE administrator SET password_hash=?, updated_at=? WHERE id=1",
      )
      .run(passwordHash, new Date().toISOString());
    this.db.exec("DELETE FROM sessions");
  }

  createSession(tokenHash: string, csrfToken: string, expiresAt: string) {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO sessions(token_hash,csrf_token,expires_at,created_at) VALUES(?,?,?,?)",
      )
      .run(tokenHash, csrfToken, expiresAt, now);
  }

  getSession(
    tokenHash: string,
  ): { csrf_token: string; expires_at: string } | undefined {
    return this.db
      .prepare("SELECT csrf_token,expires_at FROM sessions WHERE token_hash=?")
      .get(tokenHash) as { csrf_token: string; expires_at: string } | undefined;
  }

  deleteSession(tokenHash: string) {
    this.db.prepare("DELETE FROM sessions WHERE token_hash=?").run(tokenHash);
  }

  pruneSessions() {
    this.db
      .prepare("DELETE FROM sessions WHERE expires_at < ?")
      .run(new Date().toISOString());
  }

  createAddonShare(tokenHash: string, serverId: string, expiresAt: string) {
    this.db
      .prepare(
        `INSERT INTO addon_share_tokens(token_hash,server_id,expires_at,created_at)
         VALUES(?,?,?,?)`,
      )
      .run(tokenHash, serverId, expiresAt, new Date().toISOString());
  }

  claimAddonShare(tokenHash: string): { server_id: string } | undefined {
    const now = new Date().toISOString();
    return this.db
      .prepare(
        `DELETE FROM addon_share_tokens
         WHERE token_hash=? AND expires_at>?
         RETURNING server_id`,
      )
      .get(tokenHash, now) as { server_id: string } | undefined;
  }

  pruneAddonShares() {
    this.db
      .prepare("DELETE FROM addon_share_tokens WHERE expires_at<=?")
      .run(new Date().toISOString());
  }

  listServers(): ServerRow[] {
    return this.db
      .prepare("SELECT * FROM servers ORDER BY created_at DESC")
      .all() as unknown as ServerRow[];
  }

  getServer(id: string): ServerRow | undefined {
    return this.db
      .prepare("SELECT * FROM servers WHERE id=?")
      .get(id) as unknown as ServerRow | undefined;
  }

  getServerByPort(port: number, excludeId?: string): ServerRow | undefined {
    const rows = this.listServers();
    return rows.find((row) => {
      if (row.id === excludeId) return false;
      return (JSON.parse(row.config_json) as ServerConfig).port === port;
    });
  }

  insertServer(id: string, slug: string, config: ServerConfig) {
    const now = new Date().toISOString();
    const serialized = JSON.stringify(config);
    this.db
      .prepare(
        `INSERT INTO servers
          (id,slug,config_json,applied_config_json,revision,applied_revision,created_at,updated_at)
         VALUES(?,?,?,?,1,0,?,?)`,
      )
      .run(id, slug, serialized, serialized, now, now);
  }

  updateServer(id: string, config: ServerConfig) {
    this.db
      .prepare(
        "UPDATE servers SET config_json=?, revision=revision+1, updated_at=? WHERE id=?",
      )
      .run(JSON.stringify(config), new Date().toISOString(), id);
  }

  touchServerRevision(id: string) {
    this.db
      .prepare(
        "UPDATE servers SET revision=revision+1, updated_at=? WHERE id=?",
      )
      .run(new Date().toISOString(), id);
  }

  markApplied(id: string) {
    this.db
      .prepare(
        `UPDATE servers SET applied_config_json=config_json, applied_revision=revision,
         updated_at=? WHERE id=?`,
      )
      .run(new Date().toISOString(), id);
  }

  deleteServer(id: string) {
    this.db.prepare("DELETE FROM servers WHERE id=?").run(id);
  }

  insertOperation(operation: Operation) {
    this.db
      .prepare(
        `INSERT INTO operations(id,server_id,kind,status,message,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?)`,
      )
      .run(
        operation.id,
        operation.serverId,
        operation.kind,
        operation.status,
        operation.message,
        operation.createdAt,
        operation.updatedAt,
      );
  }

  updateOperation(
    id: string,
    status: Operation["status"],
    message: string | null,
  ) {
    this.db
      .prepare(
        "UPDATE operations SET status=?,message=?,updated_at=? WHERE id=?",
      )
      .run(status, message, new Date().toISOString(), id);
  }

  listOperations(serverId?: string): Operation[] {
    const rows = (
      serverId
        ? this.db
            .prepare(
              "SELECT * FROM operations WHERE server_id=? ORDER BY created_at DESC LIMIT 100",
            )
            .all(serverId)
        : this.db
            .prepare(
              "SELECT * FROM operations ORDER BY created_at DESC LIMIT 100",
            )
            .all()
    ) as any[];
    return rows.map((row) => ({
      id: row.id,
      serverId: row.server_id,
      kind: row.kind,
      status: row.status,
      message: row.message,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }
}
