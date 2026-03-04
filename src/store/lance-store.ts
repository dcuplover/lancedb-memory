import { v4 as uuidv4 } from "uuid";
import { buildWhereClause, buildOrderClause, sqlLiteral } from "./filter";
import { getSampleRow, VECTOR_COLUMN, TABLES_WITHOUT_VECTOR } from "./schema";
import type {
  AnyEntry,
  FilterExpression,
  MemoryStore,
  QueryOptions,
  StoreConfig,
  TableName,
  TableStats,
  TextSearchOptions,
  VectorSearchOptions,
} from "./types";

// ─── LanceDB 动态导入类型 ──────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LanceConnection = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LanceTable = any;

// ─── 错误类型 ──────────────────────────────────────────────────────────────────

export class DimensionMismatchError extends Error {
  constructor(expected: number, got: number) {
    super(`Vector dimension mismatch: expected ${expected}, got ${got}`);
    this.name = "DimensionMismatchError";
  }
}

// ─── LanceDBStore ─────────────────────────────────────────────────────────────

export class LanceDBStore implements MemoryStore {
  private readonly db: LanceConnection;
  private readonly config: StoreConfig;
  /** 表名 → Table 实例缓存 */
  private readonly tableCache = new Map<string, LanceTable>();

  constructor(db: LanceConnection, config: StoreConfig) {
    this.db = db;
    this.config = config;
  }

  // ─── 内部：获取（或初始化）表 ────────────────────────────────────────────────

  private async getTable(name: string): Promise<LanceTable> {
    const cached = this.tableCache.get(name);
    if (cached) return cached;

    let table: LanceTable;
    try {
      table = await this.db.openTable(name);
    } catch {
      // 表不存在，用示例行创建
      const sample = getSampleRow(name, this.config.vectorDimension);
      table = await this.db.createTable(name, [sample]);
    }
    this.tableCache.set(name, table);
    return table;
  }

  // ─── 内部：向量维度校验 ────────────────────────────────────────────────────

  private checkDimension(vector: Float32Array): void {
    if (vector.length !== this.config.vectorDimension) {
      throw new DimensionMismatchError(this.config.vectorDimension, vector.length);
    }
  }

  // ─── 内部：行反序列化（toArray 返回的对象可能含 BigInt） ──────────────────

  private deserializeRow<T>(row: Record<string, unknown>): T {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      if (typeof v === "bigint") {
        result[k] = Number(v);
      } else {
        result[k] = v;
      }
    }
    return result as unknown as T;
  }

  // ─── insert ────────────────────────────────────────────────────────────────

  async insert<T extends AnyEntry>(table: TableName, entry: T): Promise<string> {
    const t = await this.getTable(table);
    const row = this.prepareRow(entry);
    await t.add([row]);
    return entry.id;
  }

  // ─── upsert ────────────────────────────────────────────────────────────────

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
      // 新插入，确保有 id
      const full = { ...entry } as Record<string, unknown>;
      if (!full["id"]) full["id"] = uuidv4();
      await this.insert(table, full as unknown as T);
      return full["id"] as string;
    }
  }

  // ─── update ────────────────────────────────────────────────────────────────

  async update<T extends AnyEntry>(
    table: TableName,
    id: string,
    patch: Partial<T>
  ): Promise<void> {
    const t = await this.getTable(table);
    const existing = await this.getById<T>(table, id);
    if (!existing) return;

    const merged = this.prepareRow({ ...existing, ...patch } as T);
    await t.delete(`id = ${sqlLiteral(id)}`);
    await t.add([merged]);
  }

  // ─── delete ────────────────────────────────────────────────────────────────

  async delete(table: TableName, id: string): Promise<void> {
    const t = await this.getTable(table);
    await t.delete(`id = ${sqlLiteral(id)}`);
  }

  // ─── softDelete ────────────────────────────────────────────────────────────

  async softDelete(table: TableName, id: string, supersededBy?: string): Promise<void> {
    const marker = supersededBy ?? `__deleted__:${id}`;
    await this.update(table, id, { supersededBy: marker } as Record<string, unknown>);
  }

  // ─── getById ───────────────────────────────────────────────────────────────

  async getById<T extends AnyEntry>(table: TableName, id: string): Promise<T | null> {
    const t = await this.getTable(table);
    const rows: unknown[] = await t.query()
      .where(`id = ${sqlLiteral(id)}`)
      .limit(1)
      .toArray();

    if (!rows || rows.length === 0) return null;
    return this.deserializeRow<T>(rows[0] as Record<string, unknown>);
  }

  // ─── getByKey ──────────────────────────────────────────────────────────────

  async getByKey<T extends AnyEntry>(table: TableName, key: string): Promise<T | null> {
    const t = await this.getTable(table);
    const rows: unknown[] = await t.query()
      .where(`key = ${sqlLiteral(key)}`)
      .limit(1)
      .toArray();

    if (!rows || rows.length === 0) return null;
    return this.deserializeRow<T>(rows[0] as Record<string, unknown>);
  }

  // ─── vectorSearch ──────────────────────────────────────────────────────────

  async vectorSearch<T extends AnyEntry>(
    table: TableName,
    vector: Float32Array,
    options: VectorSearchOptions
  ): Promise<Array<T & { _score: number }>> {
    this.checkDimension(vector);

    if (TABLES_WITHOUT_VECTOR.has(table)) {
      return [];
    }

    const t = await this.getTable(table);
    const vectorArr = Array.from(vector);
    const topK = options.topK ?? 10;

    let q = t.vectorSearch(vectorArr)
      .column(VECTOR_COLUMN)
      .limit(topK);

    if (options.filter) {
      q = q.where(buildWhereClause(options.filter));
    }

    if (!options.includeVectors) {
      // 不在这里显式设置 select，让默认行为决定
    }

    const rawRows: unknown[] = await q.toArray();

    const results = rawRows
      .map((r) => {
        const row = this.deserializeRow<T & { _distance?: number }>(
          r as Record<string, unknown>
        );
        // 距离 → 相似度分数（余弦距离：score = 1 - distance）
        const dist = (row as Record<string, unknown>)["_distance"] as number | undefined;
        const score = dist !== undefined ? Math.max(0, 1 - dist) : 1;
        delete (row as Record<string, unknown>)["_distance"];
        return { ...row, _score: score } as T & { _score: number };
      })
      .filter((r) => options.minScore === undefined || r._score >= options.minScore);

    return results;
  }

  // ─── textSearch ────────────────────────────────────────────────────────────

  async textSearch<T extends AnyEntry>(
    table: TableName,
    query: string,
    options: TextSearchOptions
  ): Promise<Array<T & { _score: number }>> {
    const t = await this.getTable(table);
    const topK = options.topK ?? 10;

    let q = t.search(query).limit(topK);

    const rawRows: unknown[] = await q.toArray();

    return rawRows.map((r) => {
      const row = this.deserializeRow<T>(r as Record<string, unknown>);
      const score = (r as Record<string, unknown>)["_score"] as number | undefined;
      return { ...row, _score: score ?? 1 } as T & { _score: number };
    });
  }

  // ─── query ─────────────────────────────────────────────────────────────────

  async query<T extends AnyEntry>(
    table: TableName,
    filter: FilterExpression,
    options?: QueryOptions
  ): Promise<T[]> {
    const t = await this.getTable(table);
    let q = t.query().where(buildWhereClause(filter));

    if (options?.limit !== undefined) {
      q = q.limit(options.limit);
    }

    if (options?.orderBy) {
      // LanceDB query() 目前不支持原生 ORDER BY，需后处理排序
    }

    const rawRows: unknown[] = await q.toArray();
    let results = rawRows.map((r) =>
      this.deserializeRow<T>(r as Record<string, unknown>)
    );

    // 后处理：排序
    if (options?.orderBy) {
      const col = options.orderBy;
      const dir = options.orderDir ?? "asc";
      results = results.sort((a, b) => {
        const av = (a as Record<string, unknown>)[col];
        const bv = (b as Record<string, unknown>)[col];
        if (av === undefined || bv === undefined) return 0;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return dir === "asc" ? (av as any) - (bv as any) : (bv as any) - (av as any);
      });
    }

    // 后处理：offset（LanceDB 不原生支持 offset）
    if (options?.offset) {
      results = results.slice(options.offset);
    }

    return results;
  }

  // ─── bulkInsert ────────────────────────────────────────────────────────────

  async bulkInsert<T extends AnyEntry>(table: TableName, entries: T[]): Promise<string[]> {
    if (entries.length === 0) return [];

    const t = await this.getTable(table);
    const batchSize = this.config.batchSize;
    const ids: string[] = [];

    for (let i = 0; i < entries.length; i += batchSize) {
      const batch = entries.slice(i, i + batchSize);
      const rows = batch.map((e) => this.prepareRow(e));
      await t.add(rows);
      ids.push(...batch.map((e) => e.id));
    }

    return ids;
  }

  // ─── bulkDelete ────────────────────────────────────────────────────────────

  async bulkDelete(table: TableName, ids: string[]): Promise<void> {
    if (ids.length === 0) return;

    const t = await this.getTable(table);
    const list = ids.map((id) => sqlLiteral(id)).join(", ");
    await t.delete(`id IN (${list})`);
  }

  // ─── vacuum ────────────────────────────────────────────────────────────────

  async vacuum(_table: TableName): Promise<void> {
    // LanceDB 通过 table.optimize() 进行碎片整理
    // v0.12 中使用 cleanup_old_versions
    try {
      const t = await this.getTable(_table);
      if (typeof t.cleanupOldVersions === "function") {
        await t.cleanupOldVersions();
      } else if (typeof t.optimize === "function") {
        await t.optimize();
      }
    } catch {
      // vacuum 非关键操作，忽略失败
    }
  }

  // ─── getStats ──────────────────────────────────────────────────────────────

  async getStats(table: TableName): Promise<TableStats> {
    const t = await this.getTable(table);
    const rowCount: number = await t.countRows();

    // 有 supersededBy 字段的表才计算软删除数
    const tablesWithSoftDelete = new Set(["knowledge", "stm", "episodic", "entities"]);
    let softDeletedCount = 0;
    if (tablesWithSoftDelete.has(table)) {
      try {
        const deleted: unknown[] = await t.query()
          .where("supersededBy != ''")
          .limit(rowCount + 1)
          .toArray();
        softDeletedCount = Array.isArray(deleted) ? deleted.length : 0;
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

  // ─── close ─────────────────────────────────────────────────────────────────

  async close(): Promise<void> {
    this.tableCache.clear();
    // LanceDB Connection 没有显式 close API
  }

  // ─── 内部：行预处理（vector 转 number[], 保证 JSON 字段是字符串） ──────────

  private prepareRow<T>(entry: T): Record<string, unknown> {
    const row: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(entry as Record<string, unknown>)) {
      if (v instanceof Float32Array) {
        row[k] = Array.from(v);
      } else if (Array.isArray(v) && k === VECTOR_COLUMN) {
        row[k] = v;
      } else if (typeof v === "object" && v !== null && k !== VECTOR_COLUMN) {
        // 对象类型字段序列化为 JSON 字符串（如 metadata, evidence 等）
        row[k] = JSON.stringify(v);
      } else {
        row[k] = v;
      }
    }
    return row;
  }
}

// ─── 辅助：用于 buildOrderClause 导出（供测试用） ─────────────────────────────
export { buildOrderClause };
