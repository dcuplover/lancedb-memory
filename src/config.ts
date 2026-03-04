/**
 * 插件配置解析模块
 *
 * 统一解析和验证 api.pluginConfig，合并各模块的默认配置。
 */

import type { StoreConfig } from "./store/types";
import type { CollectorConfig } from "./types/evidence";
import type { RouterConfig } from "./pipeline/router";
import type { RetrieverConfig } from "./retrieval/types";
import type { CompactorConfig } from "./lifecycle/types";
import { DEFAULT_STORE_CONFIG } from "./store/types";
import { DEFAULT_COLLECTOR_CONFIG } from "./pipeline/collector";
import { DEFAULT_ROUTER_CONFIG } from "./pipeline/router";
import { DEFAULT_RETRIEVER_CONFIG } from "./retrieval/types";
import { DEFAULT_COMPACTOR_CONFIG } from "./lifecycle/types";

// ─── PluginConfig 接口 ────────────────────────────────────────────────────────

/**
 * 插件完整配置接口（所有子配置的聚合）。
 */
export interface PluginConfig {
  /** 是否启用插件（默认 true） */
  enabled: boolean;

  /** 是否自动采集 Hook 事件（默认 true） */
  autoCapture: boolean;

  /** 是否自动召回记忆（默认 true） */
  autoRecall: boolean;

  /** 数据库路径 */
  dbPath: string;

  /** 向量维度（默认 1536） */
  vectorDimension: number;

  /** 嵌入配置（必填） */
  embedding: {
    apiKey: string;
    model?: string;
    baseURL?: string;
    dimensions?: number;
  };

  /** 存储层配置 */
  store: Omit<StoreConfig, "dbPath">;

  /** 采集器配置 */
  collector: CollectorConfig;

  /** 路由器配置 */
  router: RouterConfig;

  /** 检索器配置 */
  retriever: RetrieverConfig;

  /** Re-ranker 配置（可选，启用时需提供 apiKey） */
  rerank?: {
    apiKey: string;
    baseURL?: string;
    model?: string;
  };

  /** 压缩器配置 */
  compactor: CompactorConfig;
}

// ─── parseConfig 工厂函数 ─────────────────────────────────────────────────────

/**
 * 解析并验证插件配置，合并默认值。
 *
 * @param raw  api.pluginConfig 原始配置对象
 * @returns    完整的 PluginConfig
 * @throws     缺少必要字段（如 embedding.apiKey）时抛出异常
 */
export function parseConfig(raw: unknown): PluginConfig {
  const input = (raw || {}) as Record<string, unknown>;

  // ── 1. Fail-fast 校验必要字段 ─────────────────────────────────────────
  const embedding = (input.embedding as Record<string, unknown>) || {};
  if (!embedding.apiKey) {
    throw new Error(
      "[memory-4layer] FATAL: embedding.apiKey is required in plugin config"
    );
  }

  // ── 2. 合并顶层配置 ───────────────────────────────────────────────────
  const enabled = (input.enabled as boolean) ?? true;
  const autoCapture = (input.autoCapture as boolean) ?? true;
  const autoRecall = (input.autoRecall as boolean) ?? true;
  const dbPath = (input.dbPath as string) || "~/.openclaw/memory-db";
  const vectorDimension = (input.vectorDimension as number) || 1536;

  // ── 3. 合并子模块配置 ─────────────────────────────────────────────────
  const collectorInput = (input.collector as Partial<CollectorConfig>) || {};
  const routerInput = (input.router as Partial<RouterConfig>) || {};
  const retrieverInput = (input.retriever as Partial<RetrieverConfig>) || {};
  const compactorInput = (input.compactor as Partial<CompactorConfig>) || {};
  const storeInput = (input.store as Partial<StoreConfig>) || {};  const rerankInput = (input.rerank as Record<string, unknown>) || {};
  // ── 4. 构造完整配置对象 ───────────────────────────────────────────────
  return {
    enabled,
    autoCapture,
    autoRecall,
    dbPath,
    vectorDimension,
    embedding: {
      apiKey: embedding.apiKey as string,
      model: (embedding.model as string) || "text-embedding-3-small",
      baseURL: (embedding.baseURL as string) || "https://api.openai.com/v1",
      dimensions: (embedding.dimensions as number) || vectorDimension,
    },
    store: {
      ...DEFAULT_STORE_CONFIG,
      ...storeInput,
      tables: {
        ...DEFAULT_STORE_CONFIG.tables,
        ...((storeInput.tables as typeof DEFAULT_STORE_CONFIG.tables) || {}),
      },
      vectorDimension,
    },
    collector: {
      ...DEFAULT_COLLECTOR_CONFIG,
      ...collectorInput,
    },
    router: {
      ...DEFAULT_ROUTER_CONFIG,
      ...routerInput,
    },
    retriever: {
      ...DEFAULT_RETRIEVER_CONFIG,
      ...retrieverInput,
      // 将 rerank 配置中的模型和基址同步到 retriever
      ...(rerankInput.model ? { rerankModel: rerankInput.model as string } : {}),
      ...(rerankInput.baseURL ? { rerankBaseURL: rerankInput.baseURL as string } : {}),
    },
    rerank: rerankInput.apiKey
      ? {
          apiKey: rerankInput.apiKey as string,
          baseURL: (rerankInput.baseURL as string) || "",
          model: (rerankInput.model as string) || DEFAULT_RETRIEVER_CONFIG.rerankModel,
        }
      : undefined,
    compactor: {
      ...DEFAULT_COMPACTOR_CONFIG,
      ...compactorInput,
      compaction: {
        ...DEFAULT_COMPACTOR_CONFIG.compaction,
        ...((compactorInput.compaction as typeof DEFAULT_COMPACTOR_CONFIG.compaction) || {}),
      },
      stm: {
        ...DEFAULT_COMPACTOR_CONFIG.stm,
        ...((compactorInput.stm as typeof DEFAULT_COMPACTOR_CONFIG.stm) || {}),
      },
      episodic: {
        ...DEFAULT_COMPACTOR_CONFIG.episodic,
        ...((compactorInput.episodic as typeof DEFAULT_COMPACTOR_CONFIG.episodic) || {}),
      },
      knowledge: {
        ...DEFAULT_COMPACTOR_CONFIG.knowledge,
        ...((compactorInput.knowledge as typeof DEFAULT_COMPACTOR_CONFIG.knowledge) || {}),
      },
      memoryMd: {
        ...DEFAULT_COMPACTOR_CONFIG.memoryMd,
        ...((compactorInput.memoryMd as typeof DEFAULT_COMPACTOR_CONFIG.memoryMd) || {}),
      },
    },
  };
}
