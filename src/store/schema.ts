import type { STMEntry, EpisodicEntry, KnowledgeEntry, EntityEntry, RelationEntry } from "./types";

/**
 * 各表的示例行，用于 LanceDB createTable 时推断 Schema。
 *
 * 规则：
 * - vector 字段使用 Float32Array，其长度决定存储时的向量维度
 * - JSON 字段使用空字符串 "{}" / "[]" 作为默认占位
 * - number 字段用 0 初始化
 * - string 字段用 "" 初始化
 */

export function makeSampleSTM(dim: number): STMEntry {
  return {
    id: "00000000-0000-0000-0000-000000000000",
    sessionKey: "",
    content: "",
    vector: Array.from({ length: dim }, () => 0.0) as number[],
    category: "context",
    createdAt: 0,
    expiresAt: 0,
    importance: 0,
    metadata: "{}",
  };
}

export function makeSampleEpisodic(dim: number): EpisodicEntry {
  return {
    id: "00000000-0000-0000-0000-000000000000",
    chainId: "",
    eventType: "message",
    content: "",
    vector: Array.from({ length: dim }, () => 0.0) as number[],
    intentKey: "",
    targetKey: "",
    timestamp: 0,
    sessionKey: "",
    outcome: "{}",
    metadata: "{}",
  };
}

export function makeSampleKnowledge(dim: number): KnowledgeEntry {
  return {
    id: "00000000-0000-0000-0000-000000000000",
    key: "",
    category: "fact",
    claim: "",
    vector: Array.from({ length: dim }, () => 0.0) as number[],
    evidence: "[]",
    confidence: 0,
    version: 1,
    createdAt: 0,
    updatedAt: 0,
    supersededBy: "",
    scope: "global",
    metadata: "{}",
  };
}

export function makeSampleEntity(dim: number): EntityEntry {
  return {
    id: "00000000-0000-0000-0000-000000000000",
    entityType: "concept",
    name: "",
    aliases: "[]",
    vector: Array.from({ length: dim }, () => 0.0) as number[],
    attributes: "{}",
    firstSeen: 0,
    lastSeen: 0,
    mentionCount: 0,
    scope: "global",
    metadata: "{}",
  };
}

export function makeSampleRelation(): RelationEntry {
  return {
    id: "00000000-0000-0000-0000-000000000000",
    fromEntityId: "",
    toEntityId: "",
    relationType: "",
    weight: 0,
    evidence: "[]",
    createdAt: 0,
    updatedAt: 0,
    metadata: "{}",
  };
}

/** 表名常量，供类型安全枚举 */
export const TABLE_NAMES = ["stm", "episodic", "knowledge", "entities", "relations"] as const;

/**
 * 获取指定表的示例行（用于 LanceDB schema 推断）
 */
export function getSampleRow(
  table: string,
  dim: number
): Record<string, unknown> {
  switch (table) {
    case "stm":
      return makeSampleSTM(dim) as unknown as Record<string, unknown>;
    case "episodic":
      return makeSampleEpisodic(dim) as unknown as Record<string, unknown>;
    case "knowledge":
      return makeSampleKnowledge(dim) as unknown as Record<string, unknown>;
    case "entities":
      return makeSampleEntity(dim) as unknown as Record<string, unknown>;
    case "relations":
      return makeSampleRelation() as unknown as Record<string, unknown>;
    default:
      throw new Error(`Unknown table: ${table}`);
  }
}

/**
 * 各表中用于全文搜索的字段列表
 */
export const TABLE_SEARCH_FIELDS: Record<string, string[]> = {
  stm: ["content"],
  episodic: ["content"],
  knowledge: ["claim"],
  entities: ["name"],
  relations: ["relationType"],
};

/**
 * 向量列的列名（所有含向量的表均使用 "vector"）
 */
export const VECTOR_COLUMN = "vector";

/**
 * 不含向量列的表（relations 无向量）
 */
export const TABLES_WITHOUT_VECTOR = new Set(["relations"]);
