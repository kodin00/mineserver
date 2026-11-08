import { DatabaseSync } from "node:sqlite";
import type {
  MarketplaceProjectType,
  Operation,
  ServerConfig,
} from "@mineserver/shared";

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

export interface PanelSettingsRow {
  modrinth_enabled: number;
  modrinth_contact: string;
  modrinth_token: string | null;
  modrinth_token_updated_at: string | null;
}

export interface AddonSourceRow {
  server_id: string;
  filename: string;
  provider: string;
  target: "addons" | "datapacks";
  project_type: MarketplaceProjectType;
  level_name: string | null;
  project_id: string;
  project_title: string;
  version_id: string;
  version_number: string;
  sha512: string;
  installed_at: string;
}

function isUniquePortViolation(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  return error.code === "SQLITE_CONSTRAINT_UNIQUE";
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
      CREATE TABLE IF NOT EXISTS addon_sources (
        server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        provider TEXT NOT NULL,
        target TEXT NOT NULL DEFAULT 'addons'
          CHECK(target IN ('addons','datapacks')),
        project_type TEXT NOT NULL DEFAULT 'mod',
        level_name TEXT,
        project_id TEXT NOT NULL,
        project_title TEXT NOT NULL,
        version_id TEXT NOT NULL,
        version_number TEXT NOT NULL,
        sha512 TEXT NOT NULL,
        installed_at TEXT NOT NULL,
        PRIMARY KEY (server_id, filename)
      );
      CREATE TABLE IF NOT EXISTS panel_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        modrinth_enabled INTEGER NOT NULL,
        modrinth_contact TEXT NOT NULL DEFAULT '',
        modrinth_token TEXT,
        modrinth_token_updated_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_addon_share_tokens_expires
        ON addon_share_tokens(expires_at);
    `);

    const version = (
      this.db.prepare("PRAGMA user_version").get() as { user_version: number }
    ).user_version;
    if (version < 5) {
      const columns = new Set(
        (
          this.db.prepare("PRAGMA table_info(addon_sources)").all() as Array<{
            name: string;
          }>
        ).map((column) => column.name),
      );
      this.db.exec("BEGIN IMMEDIATE");
      try {
        if (!columns.has("target")) {
          this.db.exec(
            "ALTER TABLE addon_sources ADD COLUMN target TEXT NOT NULL DEFAULT 'addons' CHECK(target IN ('addons','datapacks'))",
          );
        }
        if (!columns.has("project_type")) {
          this.db.exec(
            "ALTER TABLE addon_sources ADD COLUMN project_type TEXT NOT NULL DEFAULT 'mod'",
          );
        }
        if (!columns.has("level_name")) {
          this.db.exec("ALTER TABLE addon_sources ADD COLUMN level_name TEXT");
        }
        this.db.exec(`
          CREATE UNIQUE INDEX IF NOT EXISTS idx_addon_sources_project
            ON addon_sources(server_id,provider,target,project_id,COALESCE(level_name,''));
          PRAGMA user_version=5;
          COMMIT;
        `);
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
    if (version < 6) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        // Port uniqueness is enforced by the database so concurrent
        // create/update requests can never both win the check-then-insert.
        // Existing duplicates must be resolved by hand first; the index
        // creation fails loudly instead of silently picking a winner.
        this.db.exec(`
          CREATE UNIQUE INDEX IF NOT EXISTS idx_servers_port
            ON servers(CAST(json_extract(config_json, '$.port') AS INTEGER));
          PRAGMA user_version=6;
          COMMIT;
        `);
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
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

  /**
   * Settings are seeded once from the environment so an existing deployment
   * keeps its behaviour, and the stored row is authoritative afterwards.
   */
  getPanelSettings(seedEnabled: boolean): PanelSettingsRow {
    const existing = this.db
      .prepare(
        `SELECT modrinth_enabled,modrinth_contact,modrinth_token,
                modrinth_token_updated_at
           FROM panel_settings WHERE id=1`,
      )
      .get() as unknown as PanelSettingsRow | undefined;
    if (existing) return existing;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO panel_settings(
           id,modrinth_enabled,modrinth_contact,modrinth_token,
           modrinth_token_updated_at,updated_at
         ) VALUES(1,?,'',NULL,NULL,?)`,
      )
      .run(seedEnabled ? 1 : 0, now);
    return {
      modrinth_enabled: seedEnabled ? 1 : 0,
      modrinth_contact: "",
      modrinth_token: null,
      modrinth_token_updated_at: null,
    };
  }

  updatePanelSettings(update: {
    enabled: boolean;
    contact: string;
    // undefined leaves the stored token untouched; null clears it.
    token?: string | null;
  }) {
    const now = new Date().toISOString();
    this.getPanelSettings(update.enabled);
    if (update.token === undefined) {
      this.db
        .prepare(
          `UPDATE panel_settings
              SET modrinth_enabled=?, modrinth_contact=?, updated_at=?
            WHERE id=1`,
        )
        .run(update.enabled ? 1 : 0, update.contact, now);
      return;
    }
    const token =
      update.token === null || update.token === "" ? null : update.token;
    this.db
      .prepare(
        `UPDATE panel_settings
            SET modrinth_enabled=?, modrinth_contact=?, modrinth_token=?,
                modrinth_token_updated_at=?, updated_at=?
          WHERE id=1`,
      )
      .run(
        update.enabled ? 1 : 0,
        update.contact,
        token,
        token ? now : null,
        now,
      );
  }

  recordAddonSource(entry: AddonSourceRow) {
    const transaction = this.db.prepare(
      `INSERT INTO addon_sources(
         server_id,filename,provider,target,project_type,level_name,
         project_id,project_title,version_id,version_number,sha512,installed_at
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(server_id,provider,target,project_id,COALESCE(level_name,''))
       DO UPDATE SET
         filename=excluded.filename,
         project_type=excluded.project_type,
         project_title=excluded.project_title,
         version_id=excluded.version_id,
         version_number=excluded.version_number,
         sha512=excluded.sha512,
         installed_at=excluded.installed_at`,
    );
    transaction.run(
      entry.server_id,
      entry.filename,
      entry.provider,
      entry.target,
      entry.project_type,
      entry.level_name,
      entry.project_id,
      entry.project_title,
      entry.version_id,
      entry.version_number,
      entry.sha512,
      entry.installed_at,
    );
  }

  updateAddonSource(previous: AddonSourceRow, next: AddonSourceRow) {
    const transaction = this.db.prepare(
      `UPDATE addon_sources
          SET filename=?, project_type=?, project_title=?, version_id=?,
              version_number=?, sha512=?, installed_at=?
        WHERE server_id=? AND filename=? AND provider=? AND target=?
          AND project_id=? AND COALESCE(level_name,'')=COALESCE(?,'')`,
    );
    const result = transaction.run(
      next.filename,
      next.project_type,
      next.project_title,
      next.version_id,
      next.version_number,
      next.sha512,
      next.installed_at,
      previous.server_id,
      previous.filename,
      previous.provider,
      previous.target,
      previous.project_id,
      previous.level_name,
    );
    if (result.changes !== 1) {
      throw new Error("The installed project changed during the update");
    }
  }

  listAddonSources(serverId: string): AddonSourceRow[] {
    return this.db
      .prepare(
        `SELECT server_id,filename,provider,target,project_type,level_name,
                project_id,project_title,version_id,version_number,sha512,
                installed_at
           FROM addon_sources WHERE server_id=? ORDER BY filename`,
      )
      .all(serverId) as unknown as AddonSourceRow[];
  }

  getAddonSource(
    serverId: string,
    provider: string,
    target: "addons" | "datapacks",
    projectId: string,
    levelName: string | null,
  ): AddonSourceRow | undefined {
    return this.db
      .prepare(
        `SELECT server_id,filename,provider,target,project_type,level_name,
                project_id,project_title,version_id,version_number,sha512,
                installed_at
           FROM addon_sources
          WHERE server_id=? AND provider=? AND target=? AND project_id=?
            AND COALESCE(level_name,'')=COALESCE(?,'')`,
      )
      .get(serverId, provider, target, projectId, levelName) as
      AddonSourceRow | undefined;
  }

  deleteAddonSource(serverId: string, filename: string) {
    this.db
      .prepare("DELETE FROM addon_sources WHERE server_id=? AND filename=?")
      .run(serverId, filename);
  }

  deleteAddonSourceProject(
    serverId: string,
    provider: string,
    target: "addons" | "datapacks",
    projectId: string,
    levelName: string | null,
  ) {
    this.db
      .prepare(
        `DELETE FROM addon_sources
          WHERE server_id=? AND provider=? AND target=? AND project_id=?
            AND COALESCE(level_name,'')=COALESCE(?,'')`,
      )
      .run(serverId, provider, target, projectId, levelName);
  }

  pruneAddonShares() {
    this.db
      .prepare("DELETE FROM addon_share_tokens WHERE expires_at<=?")
      .run(new Date().toISOString());
  }

  /** Keeps only the newest `keep` operations per server (and global ones). */
  pruneOperations(keep = 500) {
    this.db
      .prepare(
        `DELETE FROM operations WHERE id IN (
           SELECT id FROM (
             SELECT id,
                    ROW_NUMBER() OVER (
                      PARTITION BY COALESCE(server_id, '')
                      ORDER BY created_at DESC, id DESC
                    ) AS rank
             FROM operations
           ) WHERE rank > ?
         )`,
      )
      .run(keep);
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
    try {
      this.db
        .prepare(
          `INSERT INTO servers
            (id,slug,config_json,applied_config_json,revision,applied_revision,created_at,updated_at)
           VALUES(?,?,?,?,1,0,?,?)`,
        )
        .run(id, slug, serialized, serialized, now, now);
    } catch (error: unknown) {
      if (isUniquePortViolation(error)) {
        throw Object.assign(
          new Error(`Port ${config.port} is already assigned`),
          { statusCode: 409 },
        );
      }
      throw error;
    }
  }

  updateServer(id: string, config: ServerConfig) {
    try {
      this.db
        .prepare(
          "UPDATE servers SET config_json=?, revision=revision+1, updated_at=? WHERE id=?",
        )
        .run(JSON.stringify(config), new Date().toISOString(), id);
    } catch (error: unknown) {
      if (isUniquePortViolation(error)) {
        throw Object.assign(
          new Error(`Port ${config.port} is already assigned`),
          { statusCode: 409 },
        );
      }
      throw error;
    }
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
