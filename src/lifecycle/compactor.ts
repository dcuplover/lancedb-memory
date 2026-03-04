/**
 * MOD5: Compactor（记忆压缩器）核心实现
 *
 * 职责：执行记忆生命周期管理——STM TTL 清理、Episodic 压缩、Knowledge 合并、MEMORY.md 同步。
 */

import { v4 as uuidv4 } from "uuid";
import * as fs from "fs";
import * as path from "path";
import type {
  Compactor,
  CompactorConfig,
  CompactionReport,
  CompactionTrigger,
  CleanupResult,
  PromotionResult,
  CompressionResult,
  MergeResult,
  SyncResult,
  ConflictEntry,
} from "./types";
import type { MemoryStore, STMEntry, EpisodicEntry, KnowledgeEntry, FilterExpression, EmbeddingProvider } from "../store/types";
import type { Logger } from "../types/evidence";
import { sha256Hex } from "../utils/hash";

// ─── 工具函数：超时包装器 ─────────────────────────────────────────────────────

async function withTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  fallback: T
): Promise<T> {
  return Promise.race([
    fn(),
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs)
    ),
  ]).catch(() => fallback);
}

// ─── 工具函数：Token 估算 ────────────────────────────────────────────────────

function estimateTokens(text: string): number {
  // 简单估算：字符数 / 4（近似 GPT tokenizer）
  return Math.ceil(text.length / 4);
}

// ─── 工厂函数 ─────────────────────────────────────────────────────────────────

export function createCompactor(
  config: CompactorConfig,
  store: MemoryStore,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  api: any,  // OpenClaw API
  logger?: Logger,
  embeddingProvider?: EmbeddingProvider
): Compactor {
  let lastReport: CompactionReport | null = null;
  let scheduledTimer: ReturnType<typeof setInterval> | null = null;
  let nextRun = Date.now() + config.compaction.intervalMs;

  // ─── STM 清理 ───────────────────────────────────────────────────────────────

  async function cleanupSTM(): Promise<CleanupResult> {
    const now = Date.now();

    // 1. 删除已过期条目
    const expiredFilter: FilterExpression = { lt: ["expiresAt", now] };
    const expired = await store.query<STMEntry>("stm", expiredFilter);
    if (expired.length > 0) {
      await store.bulkDelete("stm", expired.map((e) => e.id));
    }

    // 2. 如果仍超限，按 importance ASC 淘汰
    const stats = await store.getStats("stm");
    let evicted = 0;

    if (stats.activeCount > config.stm.maxEntries) {
      const toEvict = stats.activeCount - config.stm.maxEntries;
      const lowImportance = await store.query<STMEntry>(
        "stm",
        {},
        { limit: toEvict, orderBy: "importance", orderDir: "asc" }
      );
      if (lowImportance.length > 0) {
        await store.bulkDelete("stm", lowImportance.map((e) => e.id));
        evicted = lowImportance.length;
      }
    }

    return { layer: "stm", deleted: expired.length, evicted };
  }

  // ─── STM → Episodic 晋升 ────────────────────────────────────────────────────

  async function promoteSTMToEpisodic(): Promise<PromotionResult> {
    const now = Date.now();
    const promoteWindow = now + config.stm.promoteWindowMs;

    // 查找高重要性且即将过期的 STM 条目
    const candidatesFilter: FilterExpression = {
      and: [
        { gt: ["importance", config.stm.promoteThreshold] },
        { lt: ["expiresAt", promoteWindow] },
        { gt: ["expiresAt", now] }, // 尚未过期
      ],
    };

    const candidates = await store.query<STMEntry>("stm", candidatesFilter);
    let promoted = 0;

    for (const stmEntry of candidates) {
      try {
        // 构建 EpisodicEntry（手动映射字段）
        const episodicEntry: EpisodicEntry = {
          id: uuidv4(),
          chainId: sha256Hex(`stm_promote_${stmEntry.id}`).slice(0, 16),
          eventType: "message",
          content: stmEntry.content,
          vector: stmEntry.vector,
          intentKey: "stm_promoted",
          targetKey: stmEntry.sessionKey,
          timestamp: Date.now(),
          sessionKey: stmEntry.sessionKey,
          outcome: JSON.stringify({ success: true, promoted: true }),
          metadata: JSON.stringify({
            promotedFrom: stmEntry.id,
            originalCategory: stmEntry.category,
            originalImportance: stmEntry.importance,
          }),
        };

        await store.insert("episodic", episodicEntry);
        await store.delete("stm", stmEntry.id);
        promoted++;
      } catch (err) {
        logger?.warn?.(`[compactor] Failed to promote STM ${stmEntry.id}:`, err);
      }
    }

    return { promoted };
  }

  // ─── Episodic 事件链压缩 ────────────────────────────────────────────────────

  async function compressEpisodicChains(): Promise<CompressionResult> {
    const now = Date.now();
    const chainAgeThreshold = now - config.episodic.chainAgeThresholdMs;

    // 1. 找出所有事件链（按 chainId 分组）
    const allEvents = await store.query<EpisodicEntry>("episodic", {});
    const chainMap = new Map<string, EpisodicEntry[]>();

    for (const event of allEvents) {
      const entries = chainMap.get(event.chainId) || [];
      entries.push(event);
      chainMap.set(event.chainId, entries);
    }

    let chainsCompressed = 0;
    let eventsDeleted = 0;

    // 2. 遍历每条链，检查是否满足压缩条件
    for (const [chainId, events] of chainMap.entries()) {
      if (events.length < config.episodic.minChainLengthForCompression) continue;

      // 检查最后事件是否足够老
      const sortedEvents = events.sort((a, b) => a.timestamp - b.timestamp);
      const lastEvent = sortedEvents[sortedEvents.length - 1];
      if (lastEvent.timestamp > chainAgeThreshold) continue;

      // 检查是否已有摘要
      const hasSummary = events.some((e) => e.eventType === "summary");
      if (hasSummary) continue;

      // 3. 生成摘要（LLM 调用，10s 超时）
      try {
        const summary = await withTimeout(
          () => summarizeChain(sortedEvents, api),
          10_000,
          null
        );

        if (!summary) {
          logger?.warn?.(`[compactor] Failed to summarize chain ${chainId}: timeout`);
          continue;
        }

        // 4. 保留摘要，删除原始事件
        const summaryEntry: EpisodicEntry = {
          id: uuidv4(),
          chainId,
          eventType: "summary",
          content: summary.text,
          vector: summary.vector,
          intentKey: sortedEvents[0].intentKey,
          targetKey: sortedEvents[0].targetKey,
          timestamp: Date.now(),
          sessionKey: "system:compaction",
          outcome: JSON.stringify(summary.outcome),
          metadata: JSON.stringify({
            compressedFrom: sortedEvents.map((e) => e.id),
            originalCount: sortedEvents.length,
          }),
        };

        await store.insert("episodic", summaryEntry);
        await store.bulkDelete("episodic", sortedEvents.map((e) => e.id));

        chainsCompressed++;
        eventsDeleted += sortedEvents.length;
      } catch (err) {
        logger?.warn?.(`[compactor] Error compressing chain ${chainId}:`, err);
      }
    }

    return { layer: "episodic", chainsCompressed, eventsDeleted };
  }

  // ─── Episodic 时间窗口清理 ──────────────────────────────────────────────────

  async function cleanupOldEpisodic(): Promise<CleanupResult> {
    const cutoff = Date.now() - config.episodic.retentionMs;
    const oldFilter: FilterExpression = { lt: ["timestamp", cutoff] };
    const old = await store.query<EpisodicEntry>("episodic", oldFilter);

    if (old.length > 0) {
      await store.bulkDelete("episodic", old.map((e) => e.id));
    }

    return { layer: "episodic", deleted: old.length };
  }

  // ─── Knowledge 合并 ─────────────────────────────────────────────────────────

  async function mergeKnowledge(): Promise<MergeResult> {
    // 查询所有活跃知识条目
    const activeFilter: FilterExpression = {
      or: [{ eq: ["supersededBy", ""] }, { isNull: "supersededBy" }],
    };
    const all = await store.query<KnowledgeEntry>("knowledge", activeFilter);

    const merged: string[] = [];
    const mergedSet = new Set<string>(); // 避免重复合并

    for (let i = 0; i < all.length; i++) {
      if (mergedSet.has(all[i].id)) continue;

      // 使用 vectorSearch 查找相似条目
      try {
        const vector = new Float32Array(all[i].vector);
        const similar = await store.vectorSearch<KnowledgeEntry>("knowledge", vector, {
          topK: 10,
          minScore: config.knowledge.mergeSimilarityThreshold,
          filter: activeFilter,
        });

        // 过滤出与当前条目不同的相似条目
        const candidates = similar.filter(
          (s) => s.id !== all[i].id && s._score >= config.knowledge.mergeSimilarityThreshold
        );

        if (candidates.length === 0) continue;

        // 合并：保留 updatedAt 最新的，软删除其他
        const allToMerge = [all[i], ...candidates.map((c) => ({ ...c, _score: undefined }))];
        const sorted = allToMerge.sort((a, b) => b.updatedAt - a.updatedAt);
        const keeper = sorted[0];
        const toDelete = sorted.slice(1);

        // 合并 evidence
        const combinedEvidence = new Set<string>();
        for (const entry of allToMerge) {
          const evidenceArray = JSON.parse(entry.evidence || "[]");
          evidenceArray.forEach((e: string) => combinedEvidence.add(JSON.stringify(e)));
        }

        await store.update("knowledge", keeper.id, {
          evidence: JSON.stringify([...combinedEvidence].map((e) => JSON.parse(e))),
          version: keeper.version + 1,
          updatedAt: Date.now(),
        });

        // 软删除其他条目
        for (const entry of toDelete) {
          if (!mergedSet.has(entry.id)) {
            await store.softDelete("knowledge", entry.id, keeper.id);
            merged.push(entry.id);
            mergedSet.add(entry.id);
          }
        }

        mergedSet.add(keeper.id);
      } catch (err) {
        // vectorSearch 可能在 SQLite 后端失败，跳过
        logger?.warn?.(`[compactor] Failed to search similar knowledge for ${all[i].id}:`, err);
      }
    }

    return { layer: "knowledge", merged: merged.length };
  }

  // ─── 冲突检测 ───────────────────────────────────────────────────────────────

  async function detectConflicts(): Promise<ConflictEntry[]> {
    const activeFilter: FilterExpression = {
      or: [{ eq: ["supersededBy", ""] }, { isNull: "supersededBy" }],
    };
    const all = await store.query<KnowledgeEntry>("knowledge", activeFilter);

    // 按 key 分组
    const byKey = new Map<string, KnowledgeEntry[]>();
    for (const entry of all) {
      const entries = byKey.get(entry.key) || [];
      entries.push(entry);
      byKey.set(entry.key, entries);
    }

    const conflicts: ConflictEntry[] = [];

    for (const [key, entries] of byKey.entries()) {
      if (entries.length > 1) {
        // 同 key 多条目 = 冲突
        const sorted = entries.sort((a, b) => b.confidence - a.confidence);
        conflicts.push({
          key,
          entries: entries.map((e) => ({
            id: e.id,
            claim: e.claim,
            confidence: e.confidence,
          })),
          suggestedResolution: sorted[0].id,
        });
      }
    }

    return conflicts;
  }

  // ─── 解决冲突 ───────────────────────────────────────────────────────────────

  async function resolveConflict(key: string, keepId: string): Promise<void> {
    const activeFilter: FilterExpression = {
      and: [
        { eq: ["key", key] },
        { or: [{ eq: ["supersededBy", ""] }, { isNull: "supersededBy" }] },
      ],
    };
    const entries = await store.query<KnowledgeEntry>("knowledge", activeFilter);

    for (const entry of entries) {
      if (entry.id !== keepId) {
        await store.softDelete("knowledge", entry.id, keepId);
      }
    }
  }

  // ─── MEMORY.md 同步 ─────────────────────────────────────────────────────────

  async function syncMemoryMd(): Promise<SyncResult> {
    if (!config.memoryMd.enabled) {
      return { updated: false, entries: 0, tokens: 0 };
    }

    // 1. 查询活跃知识条目
    const activeFilter: FilterExpression = {
      or: [{ eq: ["supersededBy", ""] }, { isNull: "supersededBy" }],
    };
    const knowledge = await store.query<KnowledgeEntry>(
      "knowledge",
      activeFilter,
      { limit: config.memoryMd.maxEntries, orderBy: "confidence", orderDir: "desc" }
    );

    // 2. 按 category 分组
    const sections = {
      Preferences: knowledge.filter((k) => k.category === "preference").map((k) => k.claim),
      Rules: knowledge.filter((k) => k.category === "rule").map((k) => k.claim),
      Facts: knowledge.filter((k) => k.category === "fact").map((k) => k.claim),
      Decisions: knowledge.filter((k) => k.category === "decision").map((k) => k.claim),
    };

    // 3. 渲染 Markdown
    let content = "# Memory\n\n";
    for (const [title, items] of Object.entries(sections)) {
      if (items.length > 0) {
        content += `## ${title}\n`;
        for (const item of items) {
          content += `- ${item}\n`;
        }
        content += "\n";
      }
    }

    // 4. Token 限制检查
    let tokens = estimateTokens(content);
    if (tokens > config.memoryMd.maxTokens) {
      // 按 confidence 降序截断
      const allItems = knowledge
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, Math.floor(config.memoryMd.maxEntries * 0.8));

      const truncatedSections = {
        Preferences: allItems.filter((k) => k.category === "preference").map((k) => k.claim),
        Rules: allItems.filter((k) => k.category === "rule").map((k) => k.claim),
        Facts: allItems.filter((k) => k.category === "fact").map((k) => k.claim),
        Decisions: allItems.filter((k) => k.category === "decision").map((k) => k.claim),
      };

      content = "# Memory\n\n";
      for (const [title, items] of Object.entries(truncatedSections)) {
        if (items.length > 0) {
          content += `## ${title}\n`;
          for (const item of items) {
            content += `- ${item}\n`;
          }
          content += "\n";
        }
      }
      tokens = estimateTokens(content);
    }

    // 5. 写入文件
    try {
      const memoryPath = api.workspace?.root
        ? path.join(api.workspace.root, config.memoryMd.path)
        : path.resolve(".", config.memoryMd.path);

      fs.writeFileSync(memoryPath, content, "utf-8");

      return { updated: true, entries: knowledge.length, tokens };
    } catch (err) {
      logger?.error?.("[compactor] Failed to write MEMORY.md:", err);
      return { updated: false, entries: knowledge.length, tokens };
    }
  }

  // ─── LLM 摘要辅助函数 ───────────────────────────────────────────────────────

  async function summarizeChain(
    events: EpisodicEntry[],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    llmApi: any
  ): Promise<{ text: string; vector: number[]; outcome: Record<string, unknown> }> {
    const eventsText = events
      .map((e) => `- [${e.eventType}] ${e.content}`)
      .join("\n");

    const prompt = `总结以下事件链为一条简洁的经验记录：
${eventsText}

输出 JSON 格式：
{
  "summary": "一句话总结",
  "outcome": { "success": true/false, "errorClass": "", "recoveryAction": "" }
}`;

    const response = await llmApi.services.llm.complete({
      model: "haiku",
      prompt,
      responseFormat: "json",
    });

    const parsed = JSON.parse(response);
    let vector: number[] | Float32Array;
    if (embeddingProvider) {
      vector = await embeddingProvider.embed(parsed.summary);
    } else {
      vector = await llmApi.services.embedding.embed(parsed.summary);
    }

    return {
      text: parsed.summary,
      vector: Array.from(vector),
      outcome: parsed.outcome,
    };
  }

  // ─── 主入口：运行完整压缩 ───────────────────────────────────────────────────

  async function runCompaction(trigger: CompactionTrigger): Promise<CompactionReport> {
    const startTime = Date.now();
    const report: CompactionReport = {
      trigger,
      timestamp: startTime,
      durationMs: 0,
      results: {},
      errors: [],
    };

    // 1. STM 清理
    try {
      report.results.stmCleanup = await cleanupSTM();
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      report.errors.push({ step: "stmCleanup", error });
      logger?.error?.("[compactor] STM cleanup failed:", err);
    }

    // 2. STM 晋升
    try {
      report.results.stmPromotion = await promoteSTMToEpisodic();
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      report.errors.push({ step: "stmPromotion", error });
      logger?.error?.("[compactor] STM promotion failed:", err);
    }

    // 3. Episodic 事件链压缩
    try {
      report.results.episodicCompression = await compressEpisodicChains();
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      report.errors.push({ step: "episodicCompression", error });
      logger?.error?.("[compactor] Episodic compression failed:", err);
    }

    // 4. Episodic 时间窗口清理
    try {
      report.results.episodicCleanup = await cleanupOldEpisodic();
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      report.errors.push({ step: "episodicCleanup", error });
      logger?.error?.("[compactor] Episodic cleanup failed:", err);
    }

    // 5. Knowledge 合并
    try {
      report.results.knowledgeMerge = await mergeKnowledge();
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      report.errors.push({ step: "knowledgeMerge", error });
      logger?.error?.("[compactor] Knowledge merge failed:", err);
    }

    // 6. MEMORY.md 同步
    try {
      report.results.memoryMdSync = await syncMemoryMd();
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      report.errors.push({ step: "memoryMdSync", error });
      logger?.error?.("[compactor] MEMORY.md sync failed:", err);
    }

    report.durationMs = Date.now() - startTime;
    lastReport = report;

    logger?.info?.(
      `[compactor] Compaction completed (trigger: ${trigger}, duration: ${report.durationMs}ms)`
    );

    return report;
  }

  // ─── 单层压缩 ───────────────────────────────────────────────────────────────

  async function runLayer(layer: "stm" | "episodic" | "knowledge"): Promise<CompactionReport> {
    const startTime = Date.now();
    const report: CompactionReport = {
      trigger: "manual",
      timestamp: startTime,
      durationMs: 0,
      results: {},
      errors: [],
    };

    try {
      if (layer === "stm") {
        report.results.stmCleanup = await cleanupSTM();
        report.results.stmPromotion = await promoteSTMToEpisodic();
      } else if (layer === "episodic") {
        report.results.episodicCompression = await compressEpisodicChains();
        report.results.episodicCleanup = await cleanupOldEpisodic();
      } else if (layer === "knowledge") {
        report.results.knowledgeMerge = await mergeKnowledge();
        report.results.memoryMdSync = await syncMemoryMd();
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      report.errors.push({ step: layer, error });
      logger?.error?.(`[compactor] Layer ${layer} compaction failed:`, err);
    }

    report.durationMs = Date.now() - startTime;
    return report;
  }

  // ─── Compactor 对象 ─────────────────────────────────────────────────────────

  const compactor: Compactor = {
    runFull: () => runCompaction("manual"),
    runLayer,
    getLastReport: () => lastReport,
    getSchedule: () => ({ nextRun, intervalMs: config.compaction.intervalMs }),
    getConflicts: detectConflicts,
    resolveConflict,
    dispose: () => {
      if (scheduledTimer) {
        clearInterval(scheduledTimer);
        scheduledTimer = null;
      }
    },
  };

  // ─── 设置定时触发 ───────────────────────────────────────────────────────────

  if (config.compaction.intervalMs > 0) {
    scheduledTimer = setInterval(() => {
      nextRun = Date.now() + config.compaction.intervalMs;
      runCompaction("scheduled").catch((err) => {
        logger?.error?.("[compactor] Scheduled compaction failed:", err);
      });
    }, config.compaction.intervalMs);

    logger?.info?.(
      `[compactor] Scheduled compaction every ${config.compaction.intervalMs / 1000}s`
    );
  }

  return compactor;
}
