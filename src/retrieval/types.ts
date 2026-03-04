/**
 * MOD4: Retrieval Types（检索器类型定义）
 *
 * 定义多层记忆检索的查询、结果、配置等所有相关类型。
 */

import type { LayerLabel } from "../pipeline/router";
import type { MemoryStore, FilterExpression, EmbeddingProvider } from "../store/types";

// ─── 查询类型 ─────────────────────────────────────────────────────────────────

/** 检索层（排除 discard） */
export type RetrievalLayer = Exclude<LayerLabel, "discard">;

/** 查询输入 */
export interface RetrievalQuery {
  /** 查询文本（必填） */
  text: string;

  /** 预计算向量（可选，省去重复嵌入） */
  vector?: Float32Array;

  /** 业务意图键（用于 Episodic 精确匹配） */
  intentKey?: string;

  /** 作用对象键（用于 Episodic 精确匹配） */
  targetKey?: string;

  /** 限制检索层（默认全部） */
  layers?: RetrievalLayer[];

  /** 过滤条件 */
  filters?: {
    scope?: string;
    timeRange?: { start: number; end: number };
    categories?: string[];
    minImportance?: number;
  };

  /** 返回条数（默认使用配置中的 topK） */
  topK?: number;

  /** 分页偏移（默认 0） */
  offset?: number;
}

/** 查询结果 */
export interface RetrievalResult {
  /** 排序后的记忆条目 */
  entries: RetrievedEntry[];

  /** 总匹配数 */
  totalCount: number;

  /** 查询耗时（毫秒） */
  queryTimeMs: number;

  /** 各层命中数 */
  layerBreakdown: Partial<Record<RetrievalLayer, number>>;
}

/** 单条检索结果 */
export interface RetrievedEntry {
  id: string;
  layer: RetrievalLayer;
  content: string;

  /** 融合后的最终分数（0~1） */
  score: number;

  /** 各维度分数明细 */
  scores: {
    vector: number;
    bm25: number;
    recency: number;
    importance: number;
  };

  /** 元数据 */
  metadata: Record<string, unknown>;
}

// ─── 意图分析 ─────────────────────────────────────────────────────────────────

/** 查询类型 */
export type QueryType = "factual" | "procedural" | "preference" | "entity" | "general";

/** 意图分析结果 */
export interface IntentAnalysis {
  /** 查询类型 */
  queryType: QueryType;

  /** 层优先级（从高到低） */
  layerPriority: RetrievalLayer[];

  /** 关键词加权 */
  keywordBoosts: Map<string, number>;
}

// ─── 配置类型 ─────────────────────────────────────────────────────────────────

/** 分数融合权重 */
export interface FusionWeights {
  /** 向量相似度权重 */
  vector: number;

  /** BM25 权重 */
  bm25: number;

  /** 时效性权重 */
  recency: number;

  /** 重要性权重 */
  importance: number;
}

/** 检索器配置 */
export interface RetrieverConfig {
  /** 默认返回条数 */
  topK: number;

  /** 最低分数阈值 */
  minScore: number;

  /** 最大内容长度（字符数） */
  maxContentLength: number;

  /** 层权重（用于跨层融合） */
  layerWeights: Record<RetrievalLayer, number>;

  /** 分数融合权重 */
  fusionWeights: FusionWeights;

  /** 是否启用 Re-ranking */
  rerankEnabled: boolean;

  /** Re-ranker 模型名称 */
  rerankModel: string;

  /** Re-rank 前的候选数 */
  rerankTopK: number;

  /** 是否并行检索各层 */
  parallelLayers: boolean;

  /** 单层检索超时（毫秒） */
  timeoutMs: number;

  /** 去重相似度阈值 */
  dedupeThreshold: number;

  /** 时效性半衰期（毫秒，默认 1 天） */
  recencyHalfLifeMs: number;
}

/** 默认检索配置 */
export const DEFAULT_RETRIEVER_CONFIG: RetrieverConfig = {
  topK: 10,
  minScore: 0.3,
  maxContentLength: 500,
  layerWeights: {
    stm: 0.8,
    episodic: 1.0,
    knowledge: 1.2,
    structural: 1.1,
  },
  fusionWeights: {
    vector: 0.4,
    bm25: 0.2,
    recency: 0.2,
    importance: 0.2,
  },
  rerankEnabled: false,
  rerankModel: "cross-encoder/ms-marco-MiniLM-L-6-v2",
  rerankTopK: 20,
  parallelLayers: true,
  timeoutMs: 5000,
  dedupeThreshold: 0.9,
  recencyHalfLifeMs: 86_400_000, // 1 天
};

// ─── 检索器接口 ───────────────────────────────────────────────────────────────

/** 检索统计 */
export interface RetrieverStats {
  /** 总查询次数 */
  totalQueries: number;

  /** 平均查询耗时（毫秒） */
  avgLatencyMs: number;

  /** 各层命中率 */
  layerHitRates: Partial<Record<RetrievalLayer, number>>;
}

/** 记忆检索器接口 */
export interface Retriever {
  /** 主检索方法 */
  retrieve(query: RetrievalQuery): Promise<RetrievalResult>;

  /** 按意图键召回（针对 Episodic 事件链） */
  recallByIntent(intentKey: string, targetKey?: string, topK?: number): Promise<RetrievedEntry[]>;

  /** 按实体名召回（针对 Structural） */
  recallByEntity(entityName: string, topK?: number): Promise<RetrievedEntry[]>;

  /** 召回最近记忆 */
  recallRecent(layers: RetrievalLayer[], limit?: number): Promise<RetrievedEntry[]>;

  /** 获取统计信息 */
  getStats(): RetrieverStats;
}

// ─── 内部类型 ─────────────────────────────────────────────────────────────────

/** 带分数的条目（内部使用） */
export interface ScoredEntry {
  id: string;
  layer: RetrievalLayer;
  content: string;
  score: number;
  scores: {
    vector: number;
    bm25: number;
    recency: number;
    importance: number;
  };
  metadata: Record<string, unknown>;
  timestamp?: number; // 用于计算时效性
}
