// ─── Entry Types ──────────────────────────────────────────────────────────────

/** L1 短期记忆条目 */
export interface STMEntry {
  id: string;
  sessionKey: string;
  content: string;
  vector: number[];                   // Float32 数组，存为 number[]
  category: "context" | "pending" | "temp";
  createdAt: number;
  expiresAt: number;
  importance: number;
  metadata: string;                   // JSON 序列化
}

/** L2 情景记忆条目 */
export interface EpisodicEntry {
  id: string;
  chainId: string;
  eventType: "tool_call" | "message" | "session" | "outcome" | "summary";
  content: string;
  vector: number[];
  intentKey: string;
  targetKey: string;
  timestamp: number;
  sessionKey: string;
  outcome: string;                    // JSON 序列化 { success, errorClass?, recoveryAction? }
  metadata: string;                   // JSON 序列化
}

/** L3 知识记忆条目 */
export interface KnowledgeEntry {
  id: string;
  key: string;
  category: "preference" | "fact" | "rule" | "decision";
  claim: string;
  vector: number[];
  evidence: string;                   // JSON 序列化 Array<{ sourceId, sourceType, extractedAt }>
  confidence: number;
  version: number;
  createdAt: number;
  updatedAt: number;
  supersededBy: string;               // "" 表示未被取代
  scope: string;
  metadata: string;                   // JSON 序列化
}

/** L4 实体条目 */
export interface EntityEntry {
  id: string;
  entityType: "person" | "project" | "tool" | "concept" | "file";
  name: string;
  aliases: string;                    // JSON 序列化 string[]
  vector: number[];
  attributes: string;                 // JSON 序列化 Record<string, unknown>
  firstSeen: number;
  lastSeen: number;
  mentionCount: number;
  scope: string;
  metadata: string;                   // JSON 序列化
}

/** L4 关系条目 */
export interface RelationEntry {
  id: string;
  fromEntityId: string;
  toEntityId: string;
  relationType: string;
  weight: number;
  evidence: string;                   // JSON 序列化 string[]
  createdAt: number;
  updatedAt: number;
  metadata: string;                   // JSON 序列化
}

/** 所有条目类型的联合 */
export type AnyEntry = STMEntry | EpisodicEntry | KnowledgeEntry | EntityEntry | RelationEntry;

/** 表名枚举 */
export type TableName = "stm" | "episodic" | "knowledge" | "entities" | "relations";

// ─── 向量搜索选项 ──────────────────────────────────────────────────────────────

export interface VectorSearchOptions {
  topK: number;
  minScore?: number;
  filter?: FilterExpression;
  includeVectors?: boolean;
}

// ─── 全文搜索选项 ──────────────────────────────────────────────────────────────

export interface TextSearchOptions {
  topK: number;
  fields?: string[];
  fuzzy?: boolean;
  filter?: FilterExpression;
}

// ─── 混合搜索选项 ──────────────────────────────────────────────────────────────

export interface HybridSearchOptions {
  topK: number;
  minScore?: number;
  filter?: FilterExpression;
  /** FTS 搜索的目标字段（默认使用 TABLE_SEARCH_FIELDS） */
  ftsFields?: string[];
  /** RRF 融合参数 k（默认 60） */
  rrfK?: number;
  /** 向量搜索权重（0~1，默认 0.7） */
  vectorWeight?: number;
  /** 全文搜索权重（0~1，默认 0.3） */
  ftsWeight?: number;
}

// ─── 通用查询选项 ──────────────────────────────────────────────────────────────

export interface QueryOptions {
  limit?: number;
  offset?: number;
  orderBy?: string;
  orderDir?: "asc" | "desc";
}

// ─── FilterExpression ─────────────────────────────────────────────────────────

export interface FilterExpression {
  and?: FilterExpression[];
  or?: FilterExpression[];
  eq?: [string, unknown];
  ne?: [string, unknown];
  gt?: [string, number];
  lt?: [string, number];
  gte?: [string, number];
  lte?: [string, number];
  in?: [string, unknown[]];
  isNull?: string;
  isNotNull?: string;
}

// ─── 表统计 ───────────────────────────────────────────────────────────────────

export interface TableStats {
  tableName: TableName;
  rowCount: number;
  activeCount: number;     // 未被软删除的行数
  softDeletedCount: number;
}

// ─── Store 配置 ───────────────────────────────────────────────────────────────

export interface TableLimits {
  maxEntries: number;
}

export interface StoreConfig {
  dbPath: string;
  tables: {
    stm: TableLimits;
    episodic: TableLimits;
    knowledge: TableLimits;
    entities: TableLimits;
    relations: TableLimits;
  };
  vectorDimension: number;
  vectorIndexType: "IVF_PQ" | "HNSW";
  ftsEnabled: boolean;
  ftsLanguage: "english" | "chinese" | "auto";
  batchSize: number;
  vacuumIntervalMs: number;
}

export const DEFAULT_STORE_CONFIG: StoreConfig = {
  dbPath: "",
  tables: {
    stm: { maxEntries: 500 },
    episodic: { maxEntries: 10_000 },
    knowledge: { maxEntries: 2_000 },
    entities: { maxEntries: 1_000 },
    relations: { maxEntries: 5_000 },
  },
  vectorDimension: 1536,
  vectorIndexType: "IVF_PQ",
  ftsEnabled: true,
  ftsLanguage: "auto",
  batchSize: 100,
  vacuumIntervalMs: 86_400_000,
};

// ─── MemoryStore 接口 ─────────────────────────────────────────────────────────

export interface MemoryStore {
  // 通用 CRUD
  insert<T extends AnyEntry>(table: TableName, entry: T): Promise<string>;
  upsert<T extends AnyEntry>(table: TableName, key: string, entry: Partial<T>): Promise<string>;
  update<T extends AnyEntry>(table: TableName, id: string, patch: Partial<T>): Promise<void>;
  delete(table: TableName, id: string): Promise<void>;
  softDelete(table: TableName, id: string, supersededBy?: string): Promise<void>;

  // 查询
  getById<T extends AnyEntry>(table: TableName, id: string): Promise<T | null>;
  getByKey<T extends AnyEntry>(table: TableName, key: string): Promise<T | null>;

  // 向量搜索
  vectorSearch<T extends AnyEntry>(
    table: TableName,
    vector: Float32Array,
    options: VectorSearchOptions
  ): Promise<Array<T & { _score: number }>>;

  // 全文搜索
  textSearch<T extends AnyEntry>(
    table: TableName,
    query: string,
    options: TextSearchOptions
  ): Promise<Array<T & { _score: number }>>;

  // 混合搜索（向量 + 全文）
  hybridSearch<T extends AnyEntry>(
    table: TableName,
    text: string,
    vector: Float32Array,
    options: HybridSearchOptions
  ): Promise<Array<T & { _score: number; _vectorScore: number; _ftsScore: number }>>;

  // 条件查询
  query<T extends AnyEntry>(
    table: TableName,
    filter: FilterExpression,
    options?: QueryOptions
  ): Promise<T[]>;

  // 批量操作
  bulkInsert<T extends AnyEntry>(table: TableName, entries: T[]): Promise<string[]>;
  bulkDelete(table: TableName, ids: string[]): Promise<void>;

  // 维护
  vacuum(table: TableName): Promise<void>;
  getStats(table: TableName): Promise<TableStats>;

  // 资源释放
  close(): Promise<void>;
}

// ─── 嵌入提供者接口 ───────────────────────────────────────────────────────────

export interface EmbeddingProvider {
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
  dimension: number;
}
