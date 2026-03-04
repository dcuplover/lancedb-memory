/**
 * test/router.test.ts
 *
 * MOD3 LayerRouter 验收测试
 *
 * 覆盖验收标准：
 * AC1: 规则快路径正确分类显式指令、工具失败、会话事件
 * AC2: LLM 慢速路径返回有效 JSON，confidence ∈ [0,1]
 * AC3: 各层转换函数输出符合 Schema 的实体
 * AC4: Chain ID 对相同 intent+target+errorClass 稳定
 * AC5: 批量路由不超过 batchDelayMs 等待时间
 * AC6: LLM 失败时自动降级，不阻塞主流程
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { v4 as uuidv4 } from "uuid";
import { createLayerRouter, DEFAULT_ROUTER_CONFIG } from "../src/pipeline/router";
import type { EvidencePack } from "../src/types/evidence";
import type { MemoryStore, STMEntry, EpisodicEntry, KnowledgeEntry, EntityEntry } from "../src/store/types";

// ─── Mock Store ───────────────────────────────────────────────────────────────

function createMockStore(): MemoryStore {
  const storage = new Map<string, Map<string, unknown>>();

  const getTable = (table: string) => {
    if (!storage.has(table)) storage.set(table, new Map());
    return storage.get(table)!;
  };

  return {
    async insert(table, entry) {
      const id = (entry as { id: string }).id;
      getTable(table).set(id, entry);
      return id;
    },
    async upsert(table, key, entry) {
      const existing = await this.getByKey(table, key);
      if (existing) {
        const id = (existing as { id: string }).id;
        getTable(table).set(id, { ...existing, ...entry });
        return id;
      } else {
        const id = (entry as { id: string }).id ?? uuidv4();
        getTable(table).set(id, { ...entry, id });
        return id;
      }
    },
    async bulkInsert(table, entries) {
      const ids: string[] = [];
      for (const entry of entries) {
        const id = (entry as { id: string }).id;
        getTable(table).set(id, entry);
        ids.push(id);
      }
      return ids;
    },
    async getByKey(table, key) {
      const entries = Array.from(getTable(table).values());
      return (entries.find((e: any) => e.key === key || e.name === key) as any) || null;
    },
    async update(table, id, patch) {
      const entry = getTable(table).get(id);
      if (!entry) throw new Error("Not found");
      getTable(table).set(id, { ...entry, ...patch });
    },
    async getById(table, id) {
      return (getTable(table).get(id) as any) || null;
    },
    async delete() {},
    async softDelete() {},
    async vectorSearch() {
      return [];
    },
    async textSearch() {
      return [];
    },
    async query() {
      return [];
    },
    async bulkDelete() {},
    async vacuum() {},
    async getStats() {
      return { tableName: "stm", rowCount: 0, activeCount: 0, softDeletedCount: 0 };
    },
    async close() {},
  } as MemoryStore;
}

// ─── Mock API ─────────────────────────────────────────────────────────────────

function createMockApi(llmResponse?: string) {
  return {
    services: {
      llm: {
        complete: vi.fn(async () => {
          if (llmResponse) return llmResponse;
          return JSON.stringify({
            layer: "episodic",
            subCategory: "message",
            confidence: 0.8,
            shouldPromote: false,
          });
        }),
      },
    },
  };
}

// ─── Mock Logger ──────────────────────────────────────────────────────────────

function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

// ─── Test Data Factories ──────────────────────────────────────────────────────

function makeEvidencePack(overrides: Partial<EvidencePack> = {}): EvidencePack {
  return {
    id: uuidv4(),
    timestamp: Date.now(),
    sessionKey: "agent:test:project:abc",
    agentId: "test-agent",
    source: "message",
    intentKey: "message_general",
    targetKey: "general",
    envFingerprint: {},
    tags: [],
    importance: 0.5,
    ...overrides,
  };
}

// ─── AC1: 规则快路径正确分类 ──────────────────────────────────────────────────

describe("AC1: 规则快路径正确分类显式指令、工具失败、会话事件", () => {
  const store = createMockStore();
  const api = createMockApi();
  const logger = createMockLogger();
  const router = createLayerRouter({ classifyMode: "rules_only" }, store, api, logger);

  it("显式指令'记住'分类为 knowledge:preference", async () => {
    const pack = makeEvidencePack({
      message: { role: "user", text: "记住我喜欢 TypeScript", messageIndex: 0 },
    });

    const result = await router.route(pack);

    expect(result.layer).toBe("knowledge");
    expect(result.entryId).toBeTruthy();

    const entry = await store.getById<KnowledgeEntry>("knowledge", result.entryId!);
    expect(entry).toBeTruthy();
    expect(entry!.category).toBe("preference");
  });

  it("工具调用失败分类为 episodic:outcome", async () => {
    const pack = makeEvidencePack({
      source: "tool_call",
      toolCall: {
        toolCallId: "tc-001",
        toolName: "bash_exec",
        args: { command: "npm test" },
        argsHash: "abc123",
        result: { ok: false, exitCode: 1, stderr: "Error: Test failed", outputHash: "def456" },
        durationMs: 1200,
      },
    });

    const result = await router.route(pack);

    expect(result.layer).toBe("episodic");
    expect(result.entryId).toBeTruthy();

    const entry = await store.getById<EpisodicEntry>("episodic", result.entryId!);
    expect(entry).toBeTruthy();
    expect(entry!.eventType).toBe("outcome");
  });

  it("会话事件分类为 episodic:session", async () => {
    const pack = makeEvidencePack({
      source: "session_event",
      sessionEvent: { eventType: "new" },
    });

    const result = await router.route(pack);

    expect(result.layer).toBe("episodic");
    expect(result.entryId).toBeTruthy();

    const entry = await store.getById<EpisodicEntry>("episodic", result.entryId!);
    expect(entry).toBeTruthy();
    expect(entry!.eventType).toBe("session");
  });

  it("短消息 + 低重要性分类为 stm:context", async () => {
    const pack = makeEvidencePack({
      message: { role: "user", text: "好的", messageIndex: 0 },
      importance: 0.3,
    });

    const result = await router.route(pack);

    expect(result.layer).toBe("stm");
    expect(result.entryId).toBeTruthy();

    const entry = await store.getById<STMEntry>("stm", result.entryId!);
    expect(entry).toBeTruthy();
    expect(entry!.category).toBe("context");
  });
});

// ─── AC2: LLM 慢速路径返回有效 JSON ────────────────────────────────────────────

describe("AC2: LLM 慢速路径返回有效 JSON，confidence ∈ [0,1]", () => {
  it("LLM 返回有效 JSON，正确解析为 ClassificationResult", async () => {
    const llmResponse = JSON.stringify({
      layer: "knowledge",
      subCategory: "fact",
      confidence: 0.85,
      shouldPromote: false,
      knowledgeKey: "fact:typescript_strong_typing",
    });

    const store = createMockStore();
    const api = createMockApi(llmResponse);
    const logger = createMockLogger();
    const router = createLayerRouter({ classifyMode: "llm_only" }, store, api, logger);

    const pack = makeEvidencePack({
      message: { role: "user", text: "TypeScript is strongly typed", messageIndex: 0 },
    });

    const result = await router.route(pack);

    expect(result.layer).toBe("knowledge");
    expect(result.entryId).toBeTruthy();

    const entry = await store.getById<KnowledgeEntry>("knowledge", result.entryId!);
    expect(entry).toBeTruthy();
    expect(entry!.category).toBe("fact");
    expect(entry!.confidence).toBe(0.85);
  });

  it("LLM 返回非法 confidence，降级为 0.5", async () => {
    const llmResponse = JSON.stringify({
      layer: "stm",
      subCategory: "context",
      confidence: 1.5, // 非法值
      shouldPromote: false,
    });

    const store = createMockStore();
    const api = createMockApi(llmResponse);
    const logger = createMockLogger();
    const router = createLayerRouter({ classifyMode: "llm_only" }, store, api, logger);

    const pack = makeEvidencePack();

    await router.route(pack);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("非法 confidence"),
      expect.anything(),
    );
  });
});

// ─── AC3: 各层转换函数输出符合 Schema ──────────────────────────────────────────

describe("AC3: 各层转换函数输出符合 Schema 的实体", () => {
  const store = createMockStore();
  const api = createMockApi();
  const logger = createMockLogger();
  const router = createLayerRouter({ classifyMode: "rules_only" }, store, api, logger);

  it("STMEntry 包含所有必需字段", async () => {
    const pack = makeEvidencePack({
      message: { role: "user", text: "测试短消息", messageIndex: 0 },
      importance: 0.3,
    });

    const result = await router.route(pack);
    const entry = await store.getById<STMEntry>("stm", result.entryId!);

    expect(entry).toBeTruthy();
    expect(entry!.id).toBe(pack.id);
    expect(entry!.sessionKey).toBe(pack.sessionKey);
    expect(entry!.content).toBeTruthy();
    expect(entry!.vector).toEqual([]);
    expect(entry!.category).toBe("context");
    expect(entry!.createdAt).toBe(pack.timestamp);
    expect(entry!.expiresAt).toBeGreaterThan(entry!.createdAt);
    expect(entry!.importance).toBe(0.3);
    expect(typeof entry!.metadata).toBe("string");
  });

  it("EpisodicEntry 包含所有必需字段", async () => {
    const pack = makeEvidencePack({
      source: "tool_call",
      toolCall: {
        toolCallId: "tc-001",
        toolName: "bash_exec",
        args: { command: "ls" },
        argsHash: "abc123",
        result: { ok: true, exitCode: 0, stdout: "file.txt", outputHash: "def456" },
        durationMs: 500,
      },
      intentKey: "bash_exec_ls",
      targetKey: "general",
    });

    const result = await router.route(pack);
    const entry = await store.getById<EpisodicEntry>("episodic", result.entryId!);

    expect(entry).toBeTruthy();
    expect(entry!.id).toBe(pack.id);
    expect(entry!.chainId).toBeTruthy();
    expect(entry!.eventType).toBeTruthy();
    expect(entry!.content).toBeTruthy();
    expect(entry!.vector).toEqual([]);
    expect(entry!.intentKey).toBe("bash_exec_ls");
    expect(entry!.targetKey).toBe("general");
    expect(entry!.timestamp).toBe(pack.timestamp);
    expect(typeof entry!.outcome).toBe("string");
    expect(typeof entry!.metadata).toBe("string");
  });

  it("KnowledgeEntry 包含所有必需字段", async () => {
    const pack = makeEvidencePack({
      message: { role: "user", text: "记住我偏好使用 Vitest", messageIndex: 0 },
    });

    const result = await router.route(pack);
    const entry = await store.getById<KnowledgeEntry>("knowledge", result.entryId!);

    expect(entry).toBeTruthy();
    expect(entry!.id).toBeTruthy();
    expect(entry!.key).toBeTruthy();
    expect(entry!.category).toBe("preference");
    expect(entry!.claim).toBeTruthy();
    expect(entry!.vector).toEqual([]);
    expect(typeof entry!.evidence).toBe("string");
    expect(entry!.confidence).toBeGreaterThanOrEqual(0);
    expect(entry!.confidence).toBeLessThanOrEqual(1);
    expect(entry!.version).toBe(1);
    expect(entry!.createdAt).toBeTruthy();
    expect(entry!.updatedAt).toBeTruthy();
    expect(entry!.supersededBy).toBe("");
    expect(entry!.scope).toBeTruthy();
  });
});

// ─── AC4: Chain ID 稳定性 ─────────────────────────────────────────────────────

describe("AC4: Chain ID 对相同 intent+target+errorClass 稳定", () => {
  const store = createMockStore();
  const api = createMockApi();
  const logger = createMockLogger();
  const router = createLayerRouter({ classifyMode: "rules_only" }, store, api, logger);

  it("相同 intentKey + targetKey + errorClass 产生相同 chainId", async () => {
    const pack1 = makeEvidencePack({
      source: "tool_call",
      toolCall: {
        toolCallId: "tc-001",
        toolName: "bash_exec",
        args: { command: "npm test" },
        argsHash: "abc123",
        result: { ok: false, exitCode: 1, stderr: "Error: Test failed", outputHash: "def456" },
        durationMs: 1200,
      },
      intentKey: "bash_exec_npm_test",
      targetKey: "repo:my-project",
    });

    const pack2 = makeEvidencePack({
      id: uuidv4(), // 不同 ID
      source: "tool_call",
      toolCall: {
        toolCallId: "tc-002",
        toolName: "bash_exec",
        args: { command: "npm test" },
        argsHash: "xyz789",
        result: { ok: false, exitCode: 1, stderr: "Error: Test failed", outputHash: "ghi012" },
        durationMs: 1500,
      },
      intentKey: "bash_exec_npm_test", // 相同
      targetKey: "repo:my-project", // 相同
    });

    const result1 = await router.route(pack1);
    const result2 = await router.route(pack2);

    const entry1 = await store.getById<EpisodicEntry>("episodic", result1.entryId!);
    const entry2 = await store.getById<EpisodicEntry>("episodic", result2.entryId!);

    expect(entry1!.chainId).toBe(entry2!.chainId);
  });
});

// ─── AC5: 批量路由不超过 batchDelayMs ──────────────────────────────────────────

describe("AC5: 批量路由不超过 batchDelayMs 等待时间", () => {
  it("批量路由 11 条，按 batchSize=5 分 3 批，延迟在合理范围", async () => {
    const store = createMockStore();
    const api = createMockApi();
    const logger = createMockLogger();
    const router = createLayerRouter(
      { classifyMode: "rules_only", batchSize: 5, batchDelayMs: 50 },
      store,
      api,
      logger,
    );

    const packs = Array.from({ length: 11 }, () =>
      makeEvidencePack({
        message: { role: "user", text: "测试消息", messageIndex: 0 },
        importance: 0.3,
      }),
    );

    const startTime = Date.now();
    const results = await router.routeBatch(packs);
    const duration = Date.now() - startTime;

    expect(results).toHaveLength(11);
    expect(duration).toBeLessThan(300); // 2 次延迟 (50ms each) + 处理时间，应在 300ms 内
  });
});

// ─── AC6: LLM 失败时自动降级 ──────────────────────────────────────────────────

describe("AC6: LLM 失败时自动降级，不阻塞主流程", () => {
  it("LLM 调用抛异常，降级为 stm，不抛出错误", async () => {
    const store = createMockStore();
    const api = {
      services: {
        llm: {
          complete: vi.fn(async () => {
            throw new Error("LLM API timeout");
          }),
        },
      },
    };
    const logger = createMockLogger();
    const router = createLayerRouter({ classifyMode: "llm_only" }, store, api, logger);

    const pack = makeEvidencePack({
      message: { role: "user", text: "这是一条需要 LLM 分类的消息", messageIndex: 0 },
    });

    const result = await router.route(pack);

    expect(result.layer).toBe("stm");
    expect(result.entryId).toBeTruthy();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("LLM 分类失败"), expect.anything());
  });

  it("LLM 返回未知 layer，降级为 stm", async () => {
    const llmResponse = JSON.stringify({
      layer: "unknown_layer",
      subCategory: "test",
      confidence: 0.5,
      shouldPromote: false,
    });

    const store = createMockStore();
    const api = createMockApi(llmResponse);
    const logger = createMockLogger();
    const router = createLayerRouter({ classifyMode: "llm_only" }, store, api, logger);

    const pack = makeEvidencePack();

    const result = await router.route(pack);

    expect(result.layer).toBe("stm");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("未知 layer"),
      expect.anything(),
    );
  });
});

// ─── Additional: Structural Layer Entity Extract ─────────────────────────────

describe("Additional: Structural 层实体提取", () => {
  it("extractedEntities 触发实体创建", async () => {
    const llmResponse = JSON.stringify({
      layer: "structural",
      subCategory: "entity",
      confidence: 0.9,
      shouldPromote: false,
      extractedEntities: ["TypeScript", "Vitest"],
    });

    const store = createMockStore();
    const api = createMockApi(llmResponse);
    const logger = createMockLogger();
    const router = createLayerRouter({ classifyMode: "llm_only" }, store, api, logger);

    const pack = makeEvidencePack({
      message: { role: "user", text: "I use TypeScript and Vitest", messageIndex: 0 },
    });

    const result = await router.route(pack);

    expect(result.layer).toBe("structural");
    expect(result.entryId).toBeTruthy();

    // 验证实体已创建
    const entity1 = await store.getByKey<EntityEntry>("entities", "typescript");
    const entity2 = await store.getByKey<EntityEntry>("entities", "vitest");

    expect(entity1).toBeTruthy();
    expect(entity1!.name).toBe("typescript");
    expect(entity1!.mentionCount).toBe(1);

    expect(entity2).toBeTruthy();
    expect(entity2!.name).toBe("vitest");
  });

  it("重复提及同一实体，更新 mentionCount", async () => {
    const llmResponse = JSON.stringify({
      layer: "structural",
      subCategory: "entity",
      confidence: 0.9,
      shouldPromote: false,
      extractedEntities: ["Rust"],
    });

    const store = createMockStore();
    const api = createMockApi(llmResponse);
    const logger = createMockLogger();
    const router = createLayerRouter({ classifyMode: "llm_only" }, store, api, logger);

    const pack1 = makeEvidencePack({
      message: { role: "user", text: "I like Rust", messageIndex: 0 },
    });

    await router.route(pack1);

    const pack2 = makeEvidencePack({
      message: { role: "user", text: "Rust is amazing", messageIndex: 1 },
    });

    await router.route(pack2);

    const entity = await store.getByKey<EntityEntry>("entities", "rust");
    expect(entity).toBeTruthy();
    expect(entity!.mentionCount).toBe(2);
  });
});
