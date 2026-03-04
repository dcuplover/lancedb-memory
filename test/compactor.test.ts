/**
 * MOD5 Compactor 验收测试
 *
 * 验收标准：
 * AC1: STM 过期条目被删除，高重要性条目被升级到 Episodic
 * AC2: 完结事件链被压缩为单条摘要（mock LLM）
 * AC3: 相似度 > 0.92 的知识被合并（mock vectorSearch）
 * AC4: MEMORY.md 保持在 maxTokens 限制内
 * AC5: 定时/Hook/阈值三种触发均正常工作
 * AC6: 压缩过程中单步失败不阻塞其他步骤（错误隔离）
 * AC7: 冲突检测能发现同 key 多条目
 */

import { describe, it, expect, beforeEach } from "vitest";
import { v4 as uuidv4 } from "uuid";
import { createCompactor } from "../src/lifecycle/compactor";
import { DEFAULT_COMPACTOR_CONFIG } from "../src/lifecycle/types";
import type { CompactorConfig, Compactor } from "../src/lifecycle/types";
import type { MemoryStore, STMEntry, EpisodicEntry, KnowledgeEntry, FilterExpression, QueryOptions, VectorSearchOptions } from "../src/store/types";

// ─── Mock Store ───────────────────────────────────────────────────────────────

class MockStore implements Partial<MemoryStore> {
  private data = {
    stm: [] as STMEntry[],
    episodic: [] as EpisodicEntry[],
    knowledge: [] as KnowledgeEntry[],
  };

  async insert(table: string, entry: unknown): Promise<string> {
    const typedEntry = entry as STMEntry | EpisodicEntry | KnowledgeEntry;
    if (table === "stm") this.data.stm.push(typedEntry as STMEntry);
    else if (table === "episodic") this.data.episodic.push(typedEntry as EpisodicEntry);
    else if (table === "knowledge") this.data.knowledge.push(typedEntry as KnowledgeEntry);
    return typedEntry.id;
  }

  async delete(table: string, id: string): Promise<void> {
    if (table === "stm") this.data.stm = this.data.stm.filter((e) => e.id !== id);
    else if (table === "episodic") this.data.episodic = this.data.episodic.filter((e) => e.id !== id);
    else if (table === "knowledge") this.data.knowledge = this.data.knowledge.filter((e) => e.id !== id);
  }

  async softDelete(table: string, id: string, supersededBy?: string): Promise<void> {
    if (table === "knowledge") {
      const entry = this.data.knowledge.find((e) => e.id === id);
      if (entry) entry.supersededBy = supersededBy || "";
    }
  }

  async update(table: string, id: string, patch: Partial<unknown>): Promise<void> {
    if (table === "knowledge") {
      const entry = this.data.knowledge.find((e) => e.id === id);
      if (entry) Object.assign(entry, patch);
    }
  }

  async query<T>(table: string, filter: FilterExpression, options?: QueryOptions): Promise<T[]> {
    let result: unknown[] = [];
    
    if (table === "stm") result = [...this.data.stm];
    else if (table === "episodic") result = [...this.data.episodic];
    else if (table === "knowledge") result = [...this.data.knowledge];

    // 简单过滤实现
    result = result.filter((entry: any) => {
      if (filter.lt && entry[filter.lt[0]] >= filter.lt[1]) return false;
      if (filter.gt && entry[filter.gt[0]] <= filter.gt[1]) return false;
      if (filter.eq && entry[filter.eq[0]] !== filter.eq[1]) return false;
      if (filter.and) {
        return filter.and.every((subFilter: FilterExpression) => {
          if (subFilter.lt && entry[subFilter.lt[0]] >= subFilter.lt[1]) return false;
          if (subFilter.gt && entry[subFilter.gt[0]] <= subFilter.gt[1]) return false;
          if (subFilter.eq && entry[subFilter.eq[0]] !== subFilter.eq[1]) return false;
          if (subFilter.or) {
            return subFilter.or.some((f: FilterExpression) => {
              if (f.eq) return entry[f.eq[0]] === f.eq[1];
              if (f.isNull) return entry[f.isNull] === "" || entry[f.isNull] === null || entry[f.isNull] === undefined;
              return true;
            });
          }
          return true;
        });
      }
      if (filter.or) {
        return filter.or.some((subFilter: FilterExpression) => {
          if (subFilter.eq) return entry[subFilter.eq[0]] === subFilter.eq[1];
          if (subFilter.isNull) return entry[subFilter.isNull] === "" || entry[subFilter.isNull] === null || entry[subFilter.isNull] === undefined;
          return true;
        });
      }
      return true;
    });

    // 排序
    if (options?.orderBy) {
      result.sort((a: any, b: any) => {
        const aVal = a[options.orderBy!];
        const bVal = b[options.orderBy!];
        if (options.orderDir === "desc") return bVal - aVal;
        return aVal - bVal;
      });
    }

    // 分页
    if (options?.limit) result = result.slice(0, options.limit);

    return result as T[];
  }

  async bulkDelete(table: string, ids: string[]): Promise<void> {
    if (table === "stm") this.data.stm = this.data.stm.filter((e) => !ids.includes(e.id));
    else if (table === "episodic") this.data.episodic = this.data.episodic.filter((e) => !ids.includes(e.id));
    else if (table === "knowledge") this.data.knowledge = this.data.knowledge.filter((e) => !ids.includes(e.id));
  }

  async vectorSearch<T>(table: string, vector: Float32Array, options: VectorSearchOptions): Promise<Array<T & { _score: number }>> {
    // Mock 返回高相似度结果（用于 AC3）
    if (table === "knowledge") {
      const all = await this.query<KnowledgeEntry>(table, options.filter || {});
      return all.slice(0, options.topK).map((e) => ({ ...e, _score: 0.95 })) as unknown as Array<T & { _score: number }>;
    }
    return [];
  }

  async getStats(table: string): Promise<{ activeCount: number; rowCount: number; tableName: "stm" | "episodic" | "knowledge" | "entities" | "relations"; softDeletedCount: number }> {
    let activeCount = 0;
    if (table === "stm") activeCount = this.data.stm.length;
    else if (table === "episodic") activeCount = this.data.episodic.length;
    else if (table === "knowledge") activeCount = this.data.knowledge.filter((e) => !e.supersededBy).length;

    return { activeCount, rowCount: activeCount, tableName: table as "stm" | "episodic" | "knowledge" | "entities" | "relations", softDeletedCount: 0 };
  }

  // 测试辅助方法
  reset() {
    this.data = { stm: [], episodic: [], knowledge: [] };
  }

  getData() {
    return this.data;
  }
}

// ─── Mock API ─────────────────────────────────────────────────────────────────

const mockApi = {
  services: {
    llm: {
      complete: async ({ prompt }: { prompt: string; model: string; responseFormat: string }) => {
        // Mock LLM 返回 JSON 摘要
        return JSON.stringify({
          summary: "测试摘要：多个事件被压缩",
          outcome: { success: true, errorClass: "", recoveryAction: "" },
        });
      },
    },
    embedding: {
      embed: async (text: string) => {
        // Mock 向量
        return Array.from({ length: 4 }, () => Math.random());
      },
    },
  },
  workspace: {
    root: "/tmp/test-workspace",
  },
  log: {
    info: () => {},
    warn: () => {},
    error: () => {},
  },
};

// ─── 测试辅助：创建条目工厂 ───────────────────────────────────────────────────

function makeSTM(override: Partial<STMEntry> = {}): STMEntry {
  return {
    id: uuidv4(),
    sessionKey: "test-session",
    content: "test content",
    vector: [0.1, 0.2, 0.3, 0.4],
    category: "context",
    createdAt: Date.now(),
    expiresAt: Date.now() + 3600_000,
    importance: 0.5,
    metadata: "{}",
    ...override,
  };
}

function makeEpisodic(override: Partial<EpisodicEntry> = {}): EpisodicEntry {
  return {
    id: uuidv4(),
    chainId: "chain-test",
    eventType: "message",
    content: "test event",
    vector: [0.2, 0.3, 0.4, 0.5],
    intentKey: "test_intent",
    targetKey: "test_target",
    timestamp: Date.now(),
    sessionKey: "test-session",
    outcome: "{}",
    metadata: "{}",
    ...override,
  };
}

function makeKnowledge(override: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  return {
    id: uuidv4(),
    key: `k:${uuidv4()}`,
    category: "fact",
    claim: "test claim",
    vector: [0.3, 0.4, 0.5, 0.6],
    evidence: "[]",
    confidence: 0.9,
    version: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    supersededBy: "",
    scope: "global",
    metadata: "{}",
    ...override,
  };
}

// ─── 测试套件 ─────────────────────────────────────────────────────────────────

describe("MOD5: Compactor", () => {
  let store: MockStore;
  let compactor: Compactor;
  let config: CompactorConfig;

  beforeEach(() => {
    store = new MockStore();
    config = {
      ...DEFAULT_COMPACTOR_CONFIG,
      compaction: {
        ...DEFAULT_COMPACTOR_CONFIG.compaction,
        intervalMs: 0, // 禁用定时触发
      },
    };
    compactor = createCompactor(config, store as unknown as MemoryStore, mockApi, mockApi.log);
  });

  // ─── AC1: STM 清理与晋升 ────────────────────────────────────────────────────

  it("AC1: 删除过期 STM 条目", async () => {
    const now = Date.now();
    
    // 插入过期和未过期条目
    await store.insert("stm", makeSTM({ id: "expired-1", expiresAt: now - 1000 }));
    await store.insert("stm", makeSTM({ id: "valid-1", expiresAt: now + 10000 }));
    await store.insert("stm", makeSTM({ id: "expired-2", expiresAt: now - 5000 }));

    const report = await compactor.runFull();

    expect(report.results.stmCleanup?.deleted).toBe(2);
    expect(store.getData().stm).toHaveLength(1);
    expect(store.getData().stm[0].id).toBe("valid-1");
  });

  it("AC1: 高重要性 STM 条目被晋升到 Episodic", async () => {
    const now = Date.now();
    
    // 插入高重要性且即将过期的 STM
    await store.insert("stm", makeSTM({ 
      id: "high-importance", 
      importance: 0.8, 
      expiresAt: now + 200_000 // 即将过期（< 5分钟）
    }));
    
    // 低重要性或不即将过期的不晋升
    await store.insert("stm", makeSTM({ id: "low-importance", importance: 0.5, expiresAt: now + 200_000 }));
    await store.insert("stm", makeSTM({ id: "not-expiring", importance: 0.8, expiresAt: now + 1_000_000 }));

    const report = await compactor.runFull();

    expect(report.results.stmPromotion?.promoted).toBe(1);
    expect(store.getData().episodic).toHaveLength(1);
    expect(store.getData().stm.some((e) => e.id === "high-importance")).toBe(false);
  });

  // ─── AC2: Episodic 事件链压缩 ───────────────────────────────────────────────

  it("AC2: 完结事件链被压缩为单条摘要", async () => {
    const oldTime = Date.now() - 86_400_000 - 1000; // > 24h 前
    const chainId = "old-chain";

    // 插入 3 个相关事件
    await store.insert("episodic", makeEpisodic({ chainId, timestamp: oldTime, content: "事件1" }));
    await store.insert("episodic", makeEpisodic({ chainId, timestamp: oldTime + 1000, content: "事件2" }));
    await store.insert("episodic", makeEpisodic({ chainId, timestamp: oldTime + 2000, content: "事件3" }));

    const report = await compactor.runFull();

    expect(report.results.episodicCompression?.chainsCompressed).toBe(1);
    expect(report.results.episodicCompression?.eventsDeleted).toBe(3);
    
    // 应该只剩下摘要条目
    const remaining = store.getData().episodic;
    expect(remaining).toHaveLength(1);
    expect(remaining[0].eventType).toBe("summary");
    expect(remaining[0].chainId).toBe(chainId);
  });

  // ─── AC3: Knowledge 合并 ────────────────────────────────────────────────────

  it("AC3: 相似度 > 0.92 的知识被合并", async () => {
    // 插入相似知识条目
    await store.insert("knowledge", makeKnowledge({ 
      id: "k1", 
      key: "pref:style", 
      claim: "喜欢 TypeScript",
      updatedAt: Date.now() - 1000,
    }));
    await store.insert("knowledge", makeKnowledge({ 
      id: "k2", 
      key: "pref:style-v2", 
      claim: "偏好 TypeScript 和 ESLint",
      updatedAt: Date.now(),
    }));

    const report = await compactor.runFull();

    // vectorSearch mock 返回高相似度，触发合并
    expect(report.results.knowledgeMerge?.merged).toBeGreaterThanOrEqual(1);
    
    // 至少有一个条目被软删除
    const all = store.getData().knowledge;
    const softDeleted = all.filter((k) => k.supersededBy !== "");
    expect(softDeleted.length).toBeGreaterThanOrEqual(1);
  });

  // ─── AC4: MEMORY.md 限制 ────────────────────────────────────────────────────

  it("AC4: MEMORY.md 保持在 maxTokens 限制内", async () => {
    // 插入大量知识条目
    for (let i = 0; i < 200; i++) {
      await store.insert("knowledge", makeKnowledge({ 
        claim: `知识条目 ${i}: ${"x".repeat(100)}`,
        confidence: 0.9 - i * 0.001,
      }));
    }

    const report = await compactor.runFull();

    expect(report.results.memoryMdSync?.updated).toBe(true);
    expect(report.results.memoryMdSync?.tokens).toBeLessThanOrEqual(config.memoryMd.maxTokens);
  });

  // ─── AC5: 触发机制 ──────────────────────────────────────────────────────────

  it("AC5: runFull() 手动触发正常工作", async () => {
    const report = await compactor.runFull();

    expect(report.trigger).toBe("manual");
    expect(report.results).toBeDefined();
    expect(report.durationMs).toBeGreaterThan(0);
  });

  it("AC5: runLayer() 单层触发正常工作", async () => {
    await store.insert("stm", makeSTM({ expiresAt: Date.now() - 1000 }));

    const report = await compactor.runLayer("stm");

    expect(report.results.stmCleanup).toBeDefined();
    expect(report.results.episodicCompression).toBeUndefined();
  });

  // ─── AC6: 错误隔离 ──────────────────────────────────────────────────────────

  it("AC6: 单步失败不阻塞其他步骤", async () => {
    // 插入数据
    await store.insert("stm", makeSTM({ expiresAt: Date.now() - 1000 }));
    await store.insert("knowledge", makeKnowledge());

    // 破坏 store 的某个方法（模拟失败）
    const originalBulkDelete = store.bulkDelete.bind(store);
    let bulkDeleteCalled = 0;
    store.bulkDelete = async (table: string, ids: string[]) => {
      bulkDeleteCalled++;
      if (table === "stm") {
        throw new Error("Mock error: bulkDelete failed");
      }
      return originalBulkDelete(table, ids);
    };

    const report = await compactor.runFull();

    // 即使 STM 清理失败，其他步骤仍应执行
    expect(report.errors.length).toBeGreaterThan(0);
    expect(report.results.memoryMdSync).toBeDefined();
  });

  // ─── AC7: 冲突检测 ──────────────────────────────────────────────────────────

  it("AC7: 冲突检测能发现同 key 多条目", async () => {
    const key = "pref:common-key";
    
    // 插入相同 key 的多个条目
    await store.insert("knowledge", makeKnowledge({ key, claim: "版本1", confidence: 0.8 }));
    await store.insert("knowledge", makeKnowledge({ key, claim: "版本2", confidence: 0.9 }));
    await store.insert("knowledge", makeKnowledge({ key, claim: "版本3", confidence: 0.7 }));

    const conflicts = await compactor.getConflicts();

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].key).toBe(key);
    expect(conflicts[0].entries).toHaveLength(3);
    
    // 建议保留 confidence 最高的
    const suggested = conflicts[0].entries.find((e) => e.id === conflicts[0].suggestedResolution);
    expect(suggested?.confidence).toBe(0.9);
  });

  it("AC7: resolveConflict 保留指定条目并删除其他", async () => {
    const key = "pref:resolve-test";
    
    await store.insert("knowledge", makeKnowledge({ id: "keep", key, claim: "保留" }));
    await store.insert("knowledge", makeKnowledge({ id: "delete1", key, claim: "删除1" }));
    await store.insert("knowledge", makeKnowledge({ id: "delete2", key, claim: "删除2" }));

    await compactor.resolveConflict(key, "keep");

    const all = store.getData().knowledge;
    const active = all.filter((k) => k.key === key && !k.supersededBy);
    const softDeleted = all.filter((k) => k.key === key && k.supersededBy);

    expect(active).toHaveLength(1);
    expect(active[0].id).toBe("keep");
    expect(softDeleted).toHaveLength(2);
  });
});
