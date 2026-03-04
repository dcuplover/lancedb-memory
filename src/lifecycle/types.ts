/**
 * MOD5: Compactor（记忆压缩器）类型定义
 *
 * 定义压缩器配置、结果类型、冲突检测类型、对外接口。
 */

import type { LayerLabel } from "../pipeline/router";
import type { TableName } from "../store/types";

// ─── 触发类型 ─────────────────────────────────────────────────────────────────

export type CompactionTrigger = "scheduled" | "hook" | "threshold" | "manual";

// ─── 配置接口 ─────────────────────────────────────────────────────────────────

export interface CompactorConfig {
  // 触发配置
  compaction: {
    intervalMs: number;              // 定时触发间隔（默认 3600000 = 1h）
    enableHookTrigger: boolean;      // 是否启用 Hook 触发（默认 true）
    enableThresholdTrigger: boolean; // 是否启用阈值触发（默认 true）
  };

  // STM 配置
  stm: {
    maxEntries: number;           // 最大条目数（默认 500）
    promoteThreshold: number;     // 晋升阈值 importance（默认 0.7）
    promoteWindowMs: number;      // 晋升窗口期（默认 300000 = 5min）
  };

  // Episodic 配置
  episodic: {
    maxEntries: number;                     // 最大条目数（默认 10000）
    retentionMs: number;                    // 保留时长（默认 2592000000 = 30d）
    chainAgeThresholdMs: number;            // 事件链老化阈值（默认 86400000 = 24h）
    minChainLengthForCompression: number;   // 压缩最小链长（默认 3）
  };

  // Knowledge 配置
  knowledge: {
    maxEntries: number;              // 最大条目数（默认 2000）
    mergeSimilarityThreshold: number; // 合并相似度阈值（默认 0.92）
  };

  // MEMORY.md 配置
  memoryMd: {
    enabled: boolean;      // 是否启用（默认 true）
    maxEntries: number;    // 最大条目数（默认 150）
    maxTokens: number;     // 最大 token 数（默认 10000）
    path: string;          // 文件路径（默认 "MEMORY.md"）
  };
}

export const DEFAULT_COMPACTOR_CONFIG: CompactorConfig = {
  compaction: {
    intervalMs: 3_600_000,        // 1 hour
    enableHookTrigger: true,
    enableThresholdTrigger: true,
  },
  stm: {
    maxEntries: 500,
    promoteThreshold: 0.7,
    promoteWindowMs: 300_000,     // 5 minutes
  },
  episodic: {
    maxEntries: 10_000,
    retentionMs: 2_592_000_000,   // 30 days
    chainAgeThresholdMs: 86_400_000, // 24 hours
    minChainLengthForCompression: 3,
  },
  knowledge: {
    maxEntries: 2_000,
    mergeSimilarityThreshold: 0.92,
  },
  memoryMd: {
    enabled: true,
    maxEntries: 150,
    maxTokens: 10_000,
    path: "MEMORY.md",
  },
};

// ─── 结果类型 ─────────────────────────────────────────────────────────────────

export interface CleanupResult {
  layer: "stm" | "episodic";
  deleted: number;      // 过期/超龄删除数
  evicted?: number;     // 超限淘汰数
}

export interface PromotionResult {
  promoted: number;     // STM → Episodic 晋升数
}

export interface CompressionResult {
  layer: "episodic";
  chainsCompressed: number;  // 压缩的事件链数量
  eventsDeleted: number;     // 删除的原始事件数量
}

export interface MergeResult {
  layer: "knowledge";
  merged: number;       // 合并的知识条目数
}

export interface SyncResult {
  updated: boolean;     // 是否更新了文件
  entries: number;      // 写入的条目数
  tokens: number;       // 估算的 token 数
}

export interface CompactionReport {
  trigger: CompactionTrigger;
  timestamp: number;
  durationMs: number;
  results: {
    stmCleanup?: CleanupResult;
    stmPromotion?: PromotionResult;
    episodicCompression?: CompressionResult;
    episodicCleanup?: CleanupResult;
    knowledgeMerge?: MergeResult;
    memoryMdSync?: SyncResult;
  };
  errors: Array<{ step: string; error: string }>;
}

// ─── 冲突检测类型 ─────────────────────────────────────────────────────────────

export interface ConflictEntry {
  key: string;
  entries: Array<{
    id: string;
    claim: string;
    confidence: number;
  }>;
  suggestedResolution: string; // 建议保留的条目 ID
}

// ─── Compactor 对外接口 ───────────────────────────────────────────────────────

export interface Compactor {
  // 手动触发完整压缩
  runFull(): Promise<CompactionReport>;

  // 手动触发单层压缩
  runLayer(layer: LayerLabel): Promise<CompactionReport>;

  // 获取最近一次压缩报告
  getLastReport(): CompactionReport | null;

  // 获取调度信息
  getSchedule(): {
    nextRun: number;      // 下次运行时间戳
    intervalMs: number;   // 间隔毫秒数
  };

  // 冲突管理
  getConflicts(): Promise<ConflictEntry[]>;
  resolveConflict(key: string, keepId: string): Promise<void>;

  // 资源释放
  dispose(): void;
}
