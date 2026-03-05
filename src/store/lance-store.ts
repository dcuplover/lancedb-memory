import { v4 as uuidv4 } from "uuid";
import { buildWhereClause, buildOrderClause, sqlLiteral } from "./filter";
import { getSampleRow, VECTOR_COLUMN, TABLES_WITHOUT_VECTOR, TABLE_SEARCH_FIELDS } from "./schema";
import type {
  AnyEntry,
  FilterExpression,
  HybridSearchOptions,
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

// ─── LanceDB 单例导入 ──────────────────────────────────────────────────────────

let lancedbImportPromise: Promise<typeof import("@lancedb/lancedb")> | null = null;

export async function loadLanceDB(): Promise<typeof import("@lancedb/lancedb")> {
  if (!lancedbImportPromise) {
    lancedbImportPromise = import("@lancedb/lancedb");
  }
  try {
    return await lancedbImportPromise;
  } catch (err) {
    lancedbImportPromise = null; // 允许重试
    throw new Error(`Failed to load LanceDB: ${String(err)}`, { cause: err });
  }
}

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
  /** 已创建 FTS 索引的表集合 */
  private readonly ftsIndexed = new Set<string>();

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
      try {
        table = await this.db.createTable(name, [sample]);
      } catch (createErr: unknown) {
        // 竞态：另一个进程/调用已经创建了表
        if (String(createErr).includes("already exists")) {
          table = await this.db.openTable(name);
        } else {
          throw createErr;
        }
      }
    }

    // 如果启用 FTS，为文本字段创建全文索引
    if (this.config.ftsEnabled && !this.ftsIndexed.has(name)) {
      await this.ensureFtsIndex(name, table);
    }

    this.tableCache.set(name, table);
    return table;
  }

  // ─── 内部：确保 FTS 索引存在 ────────────────────────────────────────────────

  private async ensureFtsIndex(name: string, table: LanceTable): Promise<void> {
    const fields = TABLE_SEARCH_FIELDS[name];
    if (!fields || fields.length === 0) return;

    try {
      const lancedb = await loadLanceDB();

      // 先检查已有索引，避免重复创建
      let existingIndices: Array<{ indexType?: string; columns?: string[] }> = [];
      try {
        existingIndices = await table.listIndices();
      } catch {
        // listIndices 不可用时继续尝试创建
      }

      const indices = Array.isArray(existingIndices) ? existingIndices : [];
      for (const field of fields) {
        const hasIndex = indices.some(
          (idx) => idx.indexType === "FTS" && idx.columns?.includes(field)
        );
        if (hasIndex) continue;

        await table.createIndex(field, {
          config: lancedb.Index.fts({
            withPosition: true,
          }),
        });
      }
      this.ftsIndexed.add(name);
    } catch {
      // FTS 索引创建失败，静默跳过，标记为已尝试
      this.ftsIndexed.add(name);
    }
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
        // LanceDB/Arrow 可能返回 BigInt
        result[k] = Number(v);
      } else if (
        v !== null &&
        typeof v === "object" &&
        typeof (v as { length?: unknown }).length === "number" &&
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        typeof (v as any)[Symbol.iterator] === "function" &&
        k === VECTOR_COLUMN
      ) {
        // Arrow Vector 对象（Array.isArray 返回 false）→ 转为 number[]
        result[k] = Array.from(v as Iterable<number>);
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
    const fetchLimit = Math.min(topK * 10, 200); // over-fetch for better filtering

    let q = t.vectorSearch(vectorArr)
      .column(VECTOR_COLUMN)
      .limit(fetchLimit);

    if (options.filter) {
      q = q.where(buildWhereClause(options.filter));
    }

    const rawRows: unknown[] = await q.toArray();

    const results: Array<T & { _score: number }> = [];
    for (const r of rawRows) {
      const row = this.deserializeRow<T & { _distance?: number }>(
        r as Record<string, unknown>
      );
      const dist = Number((row as unknown as Record<string, unknown>)["_distance"] ?? 0);
      const score = 1 / (1 + dist); // 更稳健的评分方式
      delete (row as unknown as Record<string, unknown>)["_distance"];

      if (options.minScore !== undefined && score < options.minScore) continue;

      results.push({ ...row, _score: score } as T & { _score: number });
      if (results.length >= topK) break;
    }

    return results;
  }

  // ─── textSearch ────────────────────────────────────────────────────────────

  async textSearch<T extends AnyEntry>(
    table: TableName,
    query: string,
    options: TextSearchOptions
  ): Promise<Array<T & { _score: number }>> {
    if (!query.trim()) return [];

    const t = await this.getTable(table);
    const topK = options.topK ?? 10;

    // 确定 FTS 搜索字段
    const ftsColumn = options.fields?.[0] ?? TABLE_SEARCH_FIELDS[table]?.[0];

    let q;
    if (ftsColumn) {
      // 使用 FTS 模式进行全文检索
      q = t.search(query, "fts", ftsColumn).limit(topK);
    } else {
      q = t.search(query, "fts").limit(topK);
    }

    if (options.filter) {
      q = q.where(buildWhereClause(options.filter));
    }

    const rawRows: unknown[] = await q.toArray();

    return rawRows.map((r) => {
      const row = this.deserializeRow<T>(r as Record<string, unknown>);
      const rawScore = (r as Record<string, unknown>)["_score"];
      // BM25 原始分数用 sigmoid 归一化
      const numScore = rawScore != null ? Number(rawScore) : 0;
      const normalizedScore = numScore > 0 ? 1 / (1 + Math.exp(-numScore / 5)) : 0.5;
      return { ...row, _score: normalizedScore } as T & { _score: number };
    });
  }

  // ─── hybridSearch ──────────────────────────────────────────────────────────

  async hybridSearch<T extends AnyEntry>(
    table: TableName,
    text: string,
    vector: Float32Array,
    options: HybridSearchOptions
  ): Promise<Array<T & { _score: number; _vectorScore: number; _ftsScore: number }>> {
    this.checkDimension(vector);

    const topK = options.topK ?? 10;
    const rrfK = options.rrfK ?? 60;
    const vectorWeight = options.vectorWeight ?? 0.7;
    const ftsWeight = options.ftsWeight ?? 0.3;
    const hasVector = !TABLES_WITHOUT_VECTOR.has(table);

    // 并行执行向量搜索和全文搜索
    const [vectorResults, ftsResults] = await Promise.all([
      hasVector
        ? this.vectorSearch<T>(table, vector, {
            topK,
            minScore: options.minScore,
            filter: options.filter,
          })
        : Promise.resolve([]),
      this.config.ftsEnabled && text.trim()
        ? this.textSearch<T>(table, text, {
            topK,
            fields: options.ftsFields ?? TABLE_SEARCH_FIELDS[table],
            filter: options.filter,
          }).catch(() => [] as Array<T & { _score: number }>)
        : Promise.resolve([] as Array<T & { _score: number }>),
    ]);

    // RRF 融合
    type HybridEntry = T & { _score: number; _vectorScore: number; _ftsScore: number };
    const idScores = new Map<string, { rrfScore: number; vectorScore: number; ftsScore: number; entry: T }>();

    // 向量结果按排名计算 RRF 分数
    vectorResults.forEach((r, rank) => {
      const raw = r as unknown as Record<string, unknown>;
      const id = raw.id as string;
      const rrfScore = vectorWeight / (rrfK + rank + 1);
      const existing = idScores.get(id);
      if (existing) {
        existing.rrfScore += rrfScore;
        existing.vectorScore = r._score;
      } else {
        const { _score: _, ...entry } = raw;
        idScores.set(id, { rrfScore, vectorScore: r._score, ftsScore: 0, entry: entry as unknown as T });
      }
    });

    // FTS 结果按排名计算 RRF 分数
    ftsResults.forEach((r, rank) => {
      const raw = r as unknown as Record<string, unknown>;
      const id = raw.id as string;
      const rrfScore = ftsWeight / (rrfK + rank + 1);
      const existing = idScores.get(id);
      if (existing) {
        existing.rrfScore += rrfScore;
        existing.ftsScore = r._score;
      } else {
        const { _score: _, ...entry } = raw;
        idScores.set(id, { rrfScore, vectorScore: 0, ftsScore: r._score, entry: entry as unknown as T });
      }
    });

    // 按 RRF 分数排序，返回 topK
    const results: HybridEntry[] = Array.from(idScores.values())
      .sort((a, b) => b.rrfScore - a.rrfScore)
      .slice(0, topK)
      .map(({ rrfScore, vectorScore, ftsScore, entry }) => ({
        ...entry,
        _score: rrfScore,
        _vectorScore: vectorScore,
        _ftsScore: ftsScore,
      } as HybridEntry));

    // 最低分过滤
    if (options.minScore !== undefined) {
      return results.filter((r) => r._score >= options.minScore!);
    }

    return results;
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
        const av = (a as unknown as Record<string, unknown>)[col];
        const bv = (b as unknown as Record<string, unknown>)[col];
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
