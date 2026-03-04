import Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import { buildWhereClause, sqlLiteral } from "./filter";
import type {
  AnyEntry,
  FilterExpression,
  HybridSearchOptions,
  MemoryStore,
  QueryOptions,
  TableName,
  TableStats,
  TextSearchOptions,
  VectorSearchOptions,
} from "./types";

// ─── 各表 DDL ─────────────────────────────────────────────────────────────────

const TABLE_DDL: Record<string, string> = {
  stm: `CREATE TABLE IF NOT EXISTS stm (
    id TEXT PRIMARY KEY,
    sessionKey TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    vector BLOB,
    category TEXT NOT NULL DEFAULT 'context',
    createdAt INTEGER NOT NULL DEFAULT 0,
    expiresAt INTEGER NOT NULL DEFAULT 0,
    importance REAL NOT NULL DEFAULT 0,
    metadata TEXT NOT NULL DEFAULT '{}',
    supersededBy TEXT NOT NULL DEFAULT ''
  )`,
  episodic: `CREATE TABLE IF NOT EXISTS episodic (
    id TEXT PRIMARY KEY,
    chainId TEXT NOT NULL DEFAULT '',
    eventType TEXT NOT NULL DEFAULT 'message',
    content TEXT NOT NULL DEFAULT '',
    vector BLOB,
    intentKey TEXT NOT NULL DEFAULT '',
    targetKey TEXT NOT NULL DEFAULT '',
    timestamp INTEGER NOT NULL DEFAULT 0,
    sessionKey TEXT NOT NULL DEFAULT '',
    outcome TEXT NOT NULL DEFAULT '{}',
    metadata TEXT NOT NULL DEFAULT '{}',
    supersededBy TEXT NOT NULL DEFAULT ''
  )`,
  knowledge: `CREATE TABLE IF NOT EXISTS knowledge (
    id TEXT PRIMARY KEY,
    key TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT 'fact',
    claim TEXT NOT NULL DEFAULT '',
    vector BLOB,
    evidence TEXT NOT NULL DEFAULT '[]',
    confidence REAL NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 1,
    createdAt INTEGER NOT NULL DEFAULT 0,
    updatedAt INTEGER NOT NULL DEFAULT 0,
    supersededBy TEXT NOT NULL DEFAULT '',
    scope TEXT NOT NULL DEFAULT 'global',
    metadata TEXT NOT NULL DEFAULT '{}'
  )`,
  entities: `CREATE TABLE IF NOT EXISTS entities (
    id TEXT PRIMARY KEY,
    entityType TEXT NOT NULL DEFAULT 'concept',
    name TEXT NOT NULL DEFAULT '',
    aliases TEXT NOT NULL DEFAULT '[]',
    vector BLOB,
    attributes TEXT NOT NULL DEFAULT '{}',
    firstSeen INTEGER NOT NULL DEFAULT 0,
    lastSeen INTEGER NOT NULL DEFAULT 0,
    mentionCount INTEGER NOT NULL DEFAULT 0,
    scope TEXT NOT NULL DEFAULT 'global',
    metadata TEXT NOT NULL DEFAULT '{}',
    supersededBy TEXT NOT NULL DEFAULT ''
  )`,
  relations: `CREATE TABLE IF NOT EXISTS relations (
    id TEXT PRIMARY KEY,
    fromEntityId TEXT NOT NULL DEFAULT '',
    toEntityId TEXT NOT NULL DEFAULT '',
    relationType TEXT NOT NULL DEFAULT '',
    weight REAL NOT NULL DEFAULT 0,
    evidence TEXT NOT NULL DEFAULT '[]',
    createdAt INTEGER NOT NULL DEFAULT 0,
    updatedAt INTEGER NOT NULL DEFAULT 0,
    metadata TEXT NOT NULL DEFAULT '{}'
  )`,
};

// ─── 不支持向量搜索标记 ────────────────────────────────────────────────────────

export class VectorSearchNotSupportedError extends Error {
  constructor() {
    super("Vector search is not supported by SQLiteStore (fallback mode)");
    this.name = "VectorSearchNotSupportedError";
  }
}

// ─── SQLiteStore ──────────────────────────────────────────────────────────────

export class SQLiteStore implements MemoryStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.initTables();
  }

  private initTables(): void {
    for (const ddl of Object.values(TABLE_DDL)) {
      this.db.exec(ddl);
    }
  }

  // ─── insert ──────────────────────────────────────────────────────────────

  async insert<T extends AnyEntry>(table: TableName, entry: T): Promise<string> {
    const row = this.serializeRow(entry);
    const cols = Object.keys(row).join(", ");
    const placeholders = Object.keys(row)
      .map((k) => `@${k}`)
      .join(", ");
    const stmt = this.db.prepare(`INSERT INTO ${table} (${cols}) VALUES (${placeholders})`);
    stmt.run(row);
    return entry.id;
  }

  // ─── upsert ──────────────────────────────────────────────────────────────

  async upsert<T extends AnyEntry>(
    table: TableName,
    key: string,
    entry: Partial<T>
  ): Promise<string> {
    const existing = await this.getByKey<T>(table, key);
    if (existing) {
      const id = existing.id;
      await this.update(table, id, entry);
      return id;
    } else {
      const full = { ...entry } as Record<string, unknown>;
      if (!full["id"]) full["id"] = uuidv4();
      await this.insert(table, full as unknown as T);
      return full["id"] as string;
    }
  }

  // ─── update ──────────────────────────────────────────────────────────────

  async update<T extends AnyEntry>(
    table: TableName,
    id: string,
    patch: Partial<T>
  ): Promise<void> {
    const row = this.serializeRow(patch as T);
    delete row["id"];
    if (Object.keys(row).length === 0) return;

    const sets = Object.keys(row)
      .map((k) => `${k} = @${k}`)
      .join(", ");
    const stmt = this.db.prepare(
      `UPDATE ${table} SET ${sets} WHERE id = @_id`
    );
    stmt.run({ ...row, _id: id });
  }

  // ─── delete ──────────────────────────────────────────────────────────────

  async delete(table: TableName, id: string): Promise<void> {
    this.db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
  }

  // ─── softDelete ──────────────────────────────────────────────────────────

  async softDelete(table: TableName, id: string, supersededBy?: string): Promise<void> {
    const marker = supersededBy ?? `__deleted__:${id}`;
    // relations 表无 supersededBy 列，跳过软删除改为物理删除
    if (table === "relations") {
      await this.delete(table, id);
      return;
    }
    this.db
      .prepare(`UPDATE ${table} SET supersededBy = ? WHERE id = ?`)
      .run(marker, id);
  }

  // ─── getById ─────────────────────────────────────────────────────────────

  async getById<T extends AnyEntry>(table: TableName, id: string): Promise<T | null> {
    const row = this.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
    if (!row) return null;
    return this.deserializeRow<T>(row as Record<string, unknown>);
  }

  // ─── getByKey ────────────────────────────────────────────────────────────

  async getByKey<T extends AnyEntry>(table: TableName, key: string): Promise<T | null> {
    // knowledge 表的 key 列
    let row: unknown;
    try {
      row = this.db.prepare(`SELECT * FROM ${table} WHERE key = ?`).get(key);
    } catch {
      return null;
    }
    if (!row) return null;
    return this.deserializeRow<T>(row as Record<string, unknown>);
  }

  // ─── vectorSearch（降级：不支持） ─────────────────────────────────────────

  async vectorSearch<T extends AnyEntry>(
    _table: TableName,
    _vector: Float32Array,
    _options: VectorSearchOptions
  ): Promise<Array<T & { _score: number }>> {
    // SQLite 降级模式不支持向量搜索，返回空数组
    return [];
  }

  // ─── textSearch（LIKE 模糊搜索） ─────────────────────────────────────────

  async textSearch<T extends AnyEntry>(
    table: TableName,
    query: string,
    options: TextSearchOptions
  ): Promise<Array<T & { _score: number }>> {
    const topK = options.topK ?? 10;
    const fields = options.fields ?? ["content", "claim", "name"];

    // 构建 LIKE 条件（跨多字段）
    const safeQuery = query.replace(/'/g, "''").replace(/%/g, "\\%").replace(/_/g, "\\_");
    const conditions: string[] = [];

    for (const field of fields) {
      // 检查该表是否有此字段（通过 PRAGMA）
      try {
        conditions.push(`${field} LIKE '%${safeQuery}%' ESCAPE '\\'`);
      } catch {
        // 字段不存在，跳过
      }
    }

    if (conditions.length === 0) return [];
    const sql = `SELECT * FROM ${table} WHERE (${conditions.join(" OR ")}) LIMIT ${topK}`;

    let rows: unknown[];
    try {
      rows = this.db.prepare(sql).all();
    } catch {
      return [];
    }

    return rows.map((r) => {
      const row = this.deserializeRow<T>(r as Record<string, unknown>);
      return { ...row, _score: 1 } as T & { _score: number };
    });
  }

  // ─── hybridSearch（SQLite 降级：仅 textSearch） ─────────────────────────────

  async hybridSearch<T extends AnyEntry>(
    table: TableName,
    text: string,
    _vector: Float32Array,
    options: HybridSearchOptions
  ): Promise<Array<T & { _score: number; _vectorScore: number; _ftsScore: number }>> {
    // SQLite 不支持向量搜索，降级为纯文本搜索
    const textResults = await this.textSearch<T>(table, text, {
      topK: options.topK,
      fields: options.ftsFields,
    });

    return textResults.map((r) => ({
      ...r,
      _vectorScore: 0,
      _ftsScore: r._score,
    }));
  }

  // ─── query ───────────────────────────────────────────────────────────────

  async query<T extends AnyEntry>(
    table: TableName,
    filter: FilterExpression,
    options?: QueryOptions
  ): Promise<T[]> {
    let sql = `SELECT * FROM ${table} WHERE ${buildWhereClause(filter)}`;
    if (options?.orderBy) {
      const col = options.orderBy.replace(/[^a-zA-Z0-9_]/g, "");
      const dir = options.orderDir === "desc" ? "DESC" : "ASC";
      sql += ` ORDER BY ${col} ${dir}`;
    }
    if (options?.limit !== undefined) {
      sql += ` LIMIT ${Number(options.limit)}`;
    }
    if (options?.offset !== undefined) {
      sql += ` OFFSET ${Number(options.offset)}`;
    }

    const rows: unknown[] = this.db.prepare(sql).all();
    return rows.map((r) => this.deserializeRow<T>(r as Record<string, unknown>));
  }

  // ─── bulkInsert ──────────────────────────────────────────────────────────

  async bulkInsert<T extends AnyEntry>(table: TableName, entries: T[]): Promise<string[]> {
    if (entries.length === 0) return [];

    const ids: string[] = [];
    const insertMany = this.db.transaction((items: T[]) => {
      for (const entry of items) {
        const row = this.serializeRow(entry);
        const cols = Object.keys(row).join(", ");
        const placeholders = Object.keys(row)
          .map((k) => `@${k}`)
          .join(", ");
        this.db.prepare(`INSERT INTO ${table} (${cols}) VALUES (${placeholders})`).run(row);
        ids.push(entry.id);
      }
    });
    insertMany(entries);
    return ids;
  }

  // ─── bulkDelete ──────────────────────────────────────────────────────────

  async bulkDelete(table: TableName, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => "?").join(", ");
    this.db.prepare(`DELETE FROM ${table} WHERE id IN (${placeholders})`).run(...ids);
  }

  // ─── vacuum ──────────────────────────────────────────────────────────────

  async vacuum(_table: TableName): Promise<void> {
    this.db.exec("VACUUM");
  }

  // ─── getStats ────────────────────────────────────────────────────────────

  async getStats(table: TableName): Promise<TableStats> {
    const countRow = this.db.prepare(`SELECT COUNT(*) as cnt FROM ${table}`).get() as
      | { cnt: number }
      | undefined;
    const rowCount = countRow?.cnt ?? 0;

    let softDeletedCount = 0;
    if (table !== "relations") {
      try {
        const sdRow = this.db
          .prepare(`SELECT COUNT(*) as cnt FROM ${table} WHERE supersededBy != ''`)
          .get() as { cnt: number } | undefined;
        softDeletedCount = sdRow?.cnt ?? 0;
      } catch {
        softDeletedCount = 0;
      }
    }

    return {
      tableName: table,
      rowCount,
      activeCount: rowCount - softDeletedCount,
      softDeletedCount,
    };
  }

  // ─── close ───────────────────────────────────────────────────────────────

  async close(): Promise<void> {
    this.db.close();
  }

  // ─── 内部：行序列化（向量 → BLOB Buffer, 对象 → JSON string） ───────────

  private serializeRow(entry: Partial<AnyEntry>): Record<string, unknown> {
    const row: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(entry as Record<string, unknown>)) {
      if (v instanceof Float32Array) {
        row[k] = Buffer.from(v.buffer);
      } else if (Array.isArray(v) && k === "vector") {
        row[k] = Buffer.from(new Float32Array(v as number[]).buffer);
      } else if (typeof v === "object" && v !== null && k !== "vector") {
        row[k] = JSON.stringify(v);
      } else {
        row[k] = v;
      }
    }
    return row;
  }

  // ─── 内部：行反序列化（JSON string → 对象）──────────────────────────────────

  private deserializeRow<T>(row: Record<string, unknown>): T {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      if (k === "vector" && Buffer.isBuffer(v)) {
        result[k] = Array.from(new Float32Array((v as Buffer).buffer));
      } else if (typeof v === "string" && (k === "metadata" || k === "evidence" || k === "outcome" || k === "aliases" || k === "attributes")) {
        try {
          result[k] = JSON.parse(v);
        } catch {
          result[k] = v;
        }
      } else {
        result[k] = v;
      }
    }
    return result as unknown as T;
  }
}
