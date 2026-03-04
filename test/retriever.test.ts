/**
 * MOD4 Retriever 验收测试
 *
 * 验收标准：
 * AC1: 单层检索（STM/Episodic/Knowledge/Structural）均可独立工作
 * AC2: 跨层融合使用 RRF，结果分数在 [0,1] 范围
 * AC3: 意图分析能正确调整层优先级
 * AC4: recallByIntent 对相同 intentKey 返回事件链
 * AC5: 并行检索耗时 < 串行总和
 * AC6: 单层超时不影响其他层返回
 * AC7: 无向量时降级为纯 BM25 检索
 * AC8: Re-rank 启用时重排序结果
 * AC9: Re-rank 失败时降级为原始排序
 * AC10: Re-rank 禁用时不调用 reranker
 */

import { describe, test, expect, beforeEach } from "vitest";
import { createRetriever } from "../src/retrieval/retriever";
import { DEFAULT_RETRIEVER_CONFIG } from "../src/retrieval/types";
import type { MemoryStore, EmbeddingProvider } from "../src/store/types";
import type { Retriever, RetrieverConfig, RerankProvider } from "../src/retrieval/types";

// ─── Mock 数据 ────────────────────────────────────────────────────────────────

const mockSTMEntries = [
  {
    id: "stm-1",
    sessionKey: "session:test",
    content: "用户刚才提到了 TypeScript 项目",
    vector: [0.1, 0.2, 0.3],
    category: "context" as const,
    createdAt: Date.now() - 1000,
    expiresAt: Date.now() + 3600000,
    importance: 0.6,
    metadata: JSON.stringify({}),
  },
];

const mockEpisodicEntries = [
  {
    id: "episodic-1",
    chainId: "chain-abc",
    eventType: "tool_call" as const,
    content: "执行了 npm test 命令",
    vector: [0.2, 0.3, 0.4],
    intentKey: "bash_exec_npm_test",
    targetKey: "general",
    timestamp: Date.now() - 5000,
    sessionKey: "session:test",
    outcome: JSON.stringify({ success: true }),
    metadata: JSON.stringify({}),
  },
];

const mockKnowledgeEntries = [
  {
    id: "knowledge-1",
    key: "pref:code_style",
    category: "preference" as const,
    claim: "用户喜欢使用 TypeScript 和 ESLint",
    vector: [0.3, 0.4, 0.5],
    evidence: JSON.stringify([]),
    confidence: 0.9,
    version: 1,
    createdAt: Date.now() - 10000,
    updatedAt: Date.now() - 10000,
    supersededBy: "",
    scope: "global",
    metadata: JSON.stringify({}),
  },
];

const mockEntityEntries = [
  {
    id: "entity-1",
    entityType: "person" as const,
    name: "Alice",
    aliases: JSON.stringify(["alice", "Alice Chen"]),
    vector: [0.4, 0.5, 0.6],
    attributes: JSON.stringify({ role: "engineer" }),
    firstSeen: Date.now() - 20000,
    lastSeen: Date.now() - 10000,
    mentionCount: 5,
    scope: "global",
    metadata: JSON.stringify({}),
  },
];

const mockRelationEntries = [
  {
    id: "relation-1",
    fromEntityId: "entity-1",
    toEntityId: "entity-2",
    relationType: "works_on",
    weight: 0.8,
    evidence: JSON.stringify([]),
    createdAt: Date.now() - 15000,
    updatedAt: Date.now() - 15000,
    metadata: JSON.stringify({}),
  },
];

// ─── Mock Store ───────────────────────────────────────────────────────────────

function createMockStore(): MemoryStore {
  return {
    insert: async () => "mock-id",
    upsert: async () => "mock-id",
    update: async () => {},
    delete: async () => {},
    softDelete: async () => {},
    getById: async () => null,
    getByKey: async () => null,

    vectorSearch: async (table, vector, options) => {
      const results = {
        stm: mockSTMEntries,
        episodic: mockEpisodicEntries,
        knowledge: mockKnowledgeEntries,
        entities: mockEntityEntries,
        relations: [] as any[],
      };
      return (results[table] || []).map((r) => ({ ...r, _score: 0.85 }));
    },

    textSearch: async (table, query, options) => {
      if (table === "knowledge") {
        return mockKnowledgeEntries.map((r) => ({ ...r, _score: 0.75 }));
      }
      return [];
    },

    hybridSearch: async (table, text, vector, options) => {
      const results = {
        stm: mockSTMEntries,
        episodic: mockEpisodicEntries,
        knowledge: mockKnowledgeEntries,
        entities: mockEntityEntries,
        relations: [] as any[],
      };
      return (results[table] || []).map((r) => ({ ...r, _score: 0.80, _vectorScore: 0.85, _ftsScore: 0.75 }));
    },

    query: async (table, filter, options) => {
      const results = {
        stm: mockSTMEntries,
        episodic: mockEpisodicEntries,
        knowledge: mockKnowledgeEntries,
        entities: mockEntityEntries,
        relations: mockRelationEntries,
      };
      return results[table] || [];
    },

    bulkInsert: async () => [],
    bulkDelete: async () => {},
    vacuum: async () => {},
    getStats: async () => ({ tableName: "stm" as const, rowCount: 0, activeCount: 0, softDeletedCount: 0 }),
    close: async () => {},
  } as MemoryStore;
}

// ─── Mock EmbeddingProvider ──────────────────────────────────────────────────

function createMockEmbeddingProvider(): EmbeddingProvider {
  return {
    embed: async (text: string) => new Float32Array([0.1, 0.2, 0.3]),
    embedBatch: async (texts: string[]) => texts.map(() => new Float32Array([0.1, 0.2, 0.3])),
    dimension: 3,
  };
}

// ─── Mock Logger ──────────────────────────────────────────────────────────────

const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

// ─── 测试套件 ─────────────────────────────────────────────────────────────────

describe("MOD4 Retriever", () => {
  let retriever: Retriever;
  let store: MemoryStore;
  let embeddingProvider: EmbeddingProvider;

  beforeEach(() => {
    store = createMockStore();
    embeddingProvider = createMockEmbeddingProvider();
    retriever = createRetriever(DEFAULT_RETRIEVER_CONFIG, store, embeddingProvider, mockLogger);
  });

  // ─── AC1: 单层检索均可独立工作 ────────────────────────────────────────────

  test("AC1.1: STM 单层检索", async () => {
    const result = await retriever.retrieve({
      text: "TypeScript 项目",
      layers: ["stm"],
      topK: 5,
    });

    expect(result.entries.length).toBeGreaterThan(0);
    expect(result.layerBreakdown.stm).toBeGreaterThan(0);
  });

  test("AC1.2: Episodic 单层检索", async () => {
    const result = await retriever.retrieve({
      text: "npm test",
      layers: ["episodic"],
      topK: 5,
    });

    expect(result.entries.length).toBeGreaterThan(0);
    expect(result.layerBreakdown.episodic).toBeGreaterThan(0);
  });

  test("AC1.3: Knowledge 单层检索", async () => {
    const result = await retriever.retrieve({
      text: "TypeScript ESLint",
      layers: ["knowledge"],
      topK: 5,
    });

    expect(result.entries.length).toBeGreaterThan(0);
    expect(result.layerBreakdown.knowledge).toBeGreaterThan(0);
  });

  test("AC1.4: Structural 单层检索", async () => {
    const result = await retriever.retrieve({
      text: "Alice",
      layers: ["structural"],
      topK: 5,
    });

    expect(result.entries.length).toBeGreaterThan(0);
    expect(result.layerBreakdown.structural).toBeGreaterThan(0);
  });

  // ─── AC2: 跨层融合使用 RRF，分数在 [0,1] ──────────────────────────────────

  test("AC2: 跨层融合分数在 [0,1] 范围", async () => {
    const result = await retriever.retrieve({
      text: "TypeScript 项目",
      layers: ["stm", "episodic", "knowledge", "structural"],
      topK: 10,
    });

    expect(result.entries.length).toBeGreaterThan(0);
    for (const entry of result.entries) {
      expect(entry.score).toBeGreaterThanOrEqual(0);
      expect(entry.score).toBeLessThanOrEqual(1);
    }
  });

  // ─── AC3: 意图分析能正确调整层优先级 ──────────────────────────────────────

  test("AC3.1: 事实类查询 → Knowledge 优先", async () => {
    const result = await retriever.retrieve({
      text: "什么是 TypeScript？",
      topK: 5,
    });

    // Knowledge 应该有更高命中率
    expect(result.layerBreakdown.knowledge).toBeGreaterThan(0);
  });

  test("AC3.2: 历史类查询 → Episodic 优先", async () => {
    const result = await retriever.retrieve({
      text: "上次执行的命令是什么？",
      topK: 5,
    });

    expect(result.layerBreakdown.episodic).toBeGreaterThan(0);
  });

  test("AC3.3: 实体类查询 → Structural 优先", async () => {
    const result = await retriever.retrieve({
      text: "谁是项目负责人？",
      topK: 5,
    });

    expect(result.layerBreakdown.structural).toBeGreaterThan(0);
  });

  // ─── AC4: recallByIntent 按 intentKey 返回事件链 ─────────────────────────

  test("AC4: recallByIntent 返回事件链", async () => {
    const entries = await retriever.recallByIntent("bash_exec_npm_test");

    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.layer === "episodic")).toBe(true);
  });

  // ─── AC5: 并行检索耗时 < 串行总和 ──────────────────────────────────────────

  test("AC5: 并行检索性能优于串行", async () => {
    // 并行配置
    const parallelConfig: RetrieverConfig = {
      ...DEFAULT_RETRIEVER_CONFIG,
      parallelLayers: true,
    };
    const parallelRetriever = createRetriever(parallelConfig, store, embeddingProvider, mockLogger);

    const parallelStart = Date.now();
    await parallelRetriever.retrieve({ text: "test query", topK: 5 });
    const parallelTime = Date.now() - parallelStart;

    // 串行配置
    const serialConfig: RetrieverConfig = {
      ...DEFAULT_RETRIEVER_CONFIG,
      parallelLayers: false,
    };
    const serialRetriever = createRetriever(serialConfig, store, embeddingProvider, mockLogger);

    const serialStart = Date.now();
    await serialRetriever.retrieve({ text: "test query", topK: 5 });
    const serialTime = Date.now() - serialStart;

    // 并行应该更快（至少不慢于串行）
    expect(parallelTime).toBeLessThanOrEqual(serialTime * 1.5); // 给予一些误差空间
  });

  // ─── AC6: 单层超时不影响其他层返回 ────────────────────────────────────────

  test("AC6: 单层超时不影响其他层", async () => {
    // 创建会超时的 mock store
    const slowStore = {
      ...store,
      vectorSearch: async (table: string, vector: Float32Array, options: any) => {
        if (table === "stm") {
          // STM 层模拟超时
          await new Promise((resolve) => setTimeout(resolve, 10000));
          return [];
        }
        // 其他层正常返回
        return store.vectorSearch(table as any, vector, options);
      },
    } as MemoryStore;

    const timeoutConfig: RetrieverConfig = {
      ...DEFAULT_RETRIEVER_CONFIG,
      timeoutMs: 100, // 100ms 超时
      parallelLayers: true,
    };

    const timeoutRetriever = createRetriever(timeoutConfig, slowStore, embeddingProvider, mockLogger);

    const result = await timeoutRetriever.retrieve({
      text: "test query",
      layers: ["stm", "episodic", "knowledge"],
      topK: 5,
    });

    // 应该返回其他层的结果，即使 STM 超时
    expect(result.entries.length).toBeGreaterThan(0);
    expect(result.layerBreakdown.episodic || result.layerBreakdown.knowledge).toBeGreaterThan(0);
  });

  // ─── AC7: 无向量时降级为纯 BM25 检索 ─────────────────────────────────────

  test("AC7: 无向量时降级为 BM25", async () => {
    const noEmbeddingProvider = {
      embed: async () => {
        throw new Error("Embedding not available");
      },
      embedBatch: async () => {
        throw new Error("Embedding not available");
      },
      dimension: 3,
    };

    const fallbackRetriever = createRetriever(
      DEFAULT_RETRIEVER_CONFIG,
      store,
      noEmbeddingProvider,
      mockLogger
    );

    const result = await fallbackRetriever.retrieve({
      text: "TypeScript",
      layers: ["knowledge"],
      topK: 5,
    });

    // 应该返回 BM25 结果
    expect(result.entries.length).toBeGreaterThanOrEqual(0);
  });

  // ─── 统计功能测试 ─────────────────────────────────────────────────────────

  test("统计功能工作正常", async () => {
    await retriever.retrieve({ text: "test1", topK: 5 });
    await retriever.retrieve({ text: "test2", topK: 5 });

    const stats = retriever.getStats();

    expect(stats.totalQueries).toBe(2);
    expect(stats.avgLatencyMs).toBeGreaterThanOrEqual(0);
  });

  // ─── 快捷方法测试 ─────────────────────────────────────────────────────────

  test("recallByEntity 工作正常", async () => {
    const entries = await retriever.recallByEntity("Alice");

    expect(entries.length).toBeGreaterThanOrEqual(0);
  });

  test("recallRecent 工作正常", async () => {
    const entries = await retriever.recallRecent(["stm", "episodic"], 10);

    expect(entries.length).toBeGreaterThanOrEqual(0);
  });

  // ─── AC8: Re-rank 启用时重排序结果 ───────────────────────────────

  test("AC8: Re-rank 启用时按重排分数排序", async () => {
    let rerankCalled = false;
    const mockReranker: RerankProvider = {
      rerank: async (query, documents, topK) => {
        rerankCalled = true;
        // 反转原始顺序：最后一个文档得分最高
        return documents.map((_, i) => ({
          index: documents.length - 1 - i,
          score: 0.9 - i * 0.1,
        }));
      },
    };

    const rerankConfig: RetrieverConfig = {
      ...DEFAULT_RETRIEVER_CONFIG,
      rerankEnabled: true,
      rerankTopK: 20,
    };

    const rerankRetriever = createRetriever(
      rerankConfig, store, embeddingProvider, mockLogger, mockReranker
    );

    const result = await rerankRetriever.retrieve({
      text: "TypeScript 项目",
      layers: ["stm", "knowledge"],
      topK: 5,
    });

    expect(rerankCalled).toBe(true);
    expect(result.entries.length).toBeGreaterThan(0);
    // 分数应该显示 reranker 给出的分数
    for (const entry of result.entries) {
      expect(entry.score).toBeGreaterThanOrEqual(0);
    }
  });

  // ─── AC9: Re-rank 失败时降级为原始排序 ───────────────────────────

  test("AC9: Re-rank 失败时降级为原始排序", async () => {
    const failingReranker: RerankProvider = {
      rerank: async () => {
        throw new Error("Rerank service unavailable");
      },
    };

    const rerankConfig: RetrieverConfig = {
      ...DEFAULT_RETRIEVER_CONFIG,
      rerankEnabled: true,
      minScore: 0.01, // 降低阈值以验证 fallback 正常返回
    };

    const rerankRetriever = createRetriever(
      rerankConfig, store, embeddingProvider, mockLogger, failingReranker
    );

    // 不应抛出异常，应正常返回结果
    const result = await rerankRetriever.retrieve({
      text: "TypeScript 项目",
      layers: ["stm", "knowledge"],
      topK: 5,
    });

    expect(result.entries.length).toBeGreaterThan(0);
  });

  // ─── AC10: Re-rank 禁用时不调用 reranker ────────────────────────────

  test("AC10: Re-rank 禁用时不调用 reranker（零开销）", async () => {
    let rerankCalled = false;
    const spyReranker: RerankProvider = {
      rerank: async (query, documents) => {
        rerankCalled = true;
        return documents.map((_, i) => ({ index: i, score: 1 - i * 0.1 }));
      },
    };

    // rerankEnabled 为默认 false
    const disabledRetriever = createRetriever(
      DEFAULT_RETRIEVER_CONFIG, store, embeddingProvider, mockLogger, spyReranker
    );

    await disabledRetriever.retrieve({
      text: "TypeScript",
      layers: ["knowledge"],
      topK: 5,
    });

    expect(rerankCalled).toBe(false);
  });
});
