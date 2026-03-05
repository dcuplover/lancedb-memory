/**
 * 四层记忆系统插件入口
 *
 * MOD1 — EventCollector（事件采集器）✅
 * MOD2 — MemoryStore（LanceDB 四层存储）✅
 * MOD3 — LayerRouter（EvidencePack 分类路由）✅
 * MOD4 — Retriever（多层检索融合）✅
 * MOD5 — Compactor（记忆生命周期管理）✅
 * MOD6 — Tools & CLI（memory_recall / memory_store / memory_forget / memory_stats）✅
 */

import { createEventCollector } from "./src/pipeline/collector";
import { createLayerRouter } from "./src/pipeline/router";
import { initializeStore } from "./src/store";
import type { MemoryStore, EmbeddingProvider } from "./src/store";
import type { HookContext } from "./src/types/evidence";
import type { LayerRouter } from "./src/pipeline/router";
import { createRetriever } from "./src/retrieval/retriever";
import { createRerankProvider } from "./src/retrieval/reranker";
import type { Retriever, RetrievedEntry } from "./src/retrieval/types";
import { createCompactor } from "./src/lifecycle/compactor";
import type { Compactor } from "./src/lifecycle/types";
import { parseConfig } from "./src/config";
import { registerTools } from "./src/tools";
import { registerCli } from "./src/cli";
import { createEmbeddingProvider } from "./src/utils/embedding";

// ─────────────────────────────────────────────────────────────────────────────
// OpenClaw 插件定义
// ─────────────────────────────────────────────────────────────────────────────

const definition = {
  id: "memory-4layer",
  name: "四层记忆系统",
  kind: "memory",

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  register: (api: any) => {
    // ── 安全 logger 包装器（防止 api.log 为 undefined 时崩溃） ────────────
    const log = {
      info: (...args: unknown[]) => api.log?.info?.(...args),
      warn: (...args: unknown[]) => api.log?.warn?.(...args),
      error: (...args: unknown[]) => api.log?.error?.(...args),
    };

    // ── 1. 解析并验证配置 ─────────────────────────────────────────────────
    let config;
    try {
      config = parseConfig(api.pluginConfig);
    } catch (err) {
      log.error("[memory] 配置解析失败：", err);
      throw err;
    }

    if (!config.enabled) {
      log.info("[memory] 插件已禁用");
      return;
    }

    const { autoCapture, autoRecall } = config;

    // ── 2. 初始化 MOD1：EventCollector（同步） ────────────────────────────
    const collector = createEventCollector(config.collector, log);

    // ── 创建 EmbeddingProvider（同步） ────────────────────────────────────
    const embeddingProvider: EmbeddingProvider = createEmbeddingProvider({
      apiKey: config.embedding.apiKey,
      baseURL: config.embedding.baseURL!,
      model: config.embedding.model!,
      dimensions: config.embedding.dimensions!,
    });

    // ── 延迟初始化重型异步组件 ─────────────────────────────────────────────
    let store: MemoryStore | undefined;
    let router: LayerRouter | undefined;
    let retriever: Retriever | undefined;
    let compactor: Compactor | undefined;
    let initPromise: Promise<void> | null = null;
    let initDone = false;

    const ensureInitialized = (): Promise<void> => {
      if (initDone) return Promise.resolve();
      if (!initPromise) {
        initPromise = (async () => {
          // ── 3. 初始化 MOD2：MemoryStore ─────────────────────────────────
          try {
            store = await initializeStore({ dbPath: config.dbPath, ...config.store }, log);
            log.info("[memory] MemoryStore 初始化完成");
          } catch (err) {
            log.error("[memory] MemoryStore 初始化失败，运行于无持久化模式：", err);
          }

          // ── 4. 初始化 MOD3：LayerRouter ─────────────────────────────────
          if (store) {
            try {
              router = createLayerRouter(config.router, store, api, log);
              log.info("[memory] LayerRouter 初始化完成");
            } catch (err) {
              log.error("[memory] LayerRouter 初始化失败：", err);
            }
          }

          // ── 5. 初始化 MOD4：Retriever ────────────────────────────────────
          if (store) {
            try {
              retriever = createRetriever(
                config.retriever,
                store,
                embeddingProvider,
                log,
                config.retriever.rerankEnabled && config.rerank?.apiKey
                  ? createRerankProvider({
                      baseURL:
                        config.rerank.baseURL ||
                        config.retriever.rerankBaseURL ||
                        "https://api.cohere.ai/v1",
                      apiKey: config.rerank.apiKey,
                      model: config.rerank.model || config.retriever.rerankModel,
                    })
                  : undefined
              );
              log.info(
                `[memory] Retriever 初始化完成${config.retriever.rerankEnabled ? "（Re-ranker 已启用）" : ""}`
              );
            } catch (err) {
              log.error("[memory] Retriever 初始化失败：", err);
            }
          }

          // ── 6. 初始化 MOD5：Compactor ────────────────────────────────────
          if (store) {
            try {
              compactor = createCompactor(config.compactor, store, api, log, embeddingProvider);
              log.info("[memory] Compactor 初始化完成");

              // 启动定时压缩
              const intervalMs = config.compactor.compaction.intervalMs;
              if (intervalMs > 0) {
                setInterval(() => {
                  compactor?.runFull().catch((err: unknown) => {
                    log.warn("[memory] 定时压缩失败：", err);
                  });
                }, intervalMs);
              }
            } catch (err) {
              log.error("[memory] Compactor 初始化失败：", err);
            }
          }

          initDone = true;
          log.info("[memory-4layer] 插件初始化完成 (MOD1-MOD6 全部就绪)");
        })().catch((err) => {
          initDone = true; // 即使失败也标记完成，避免反复重试
          log.error("[memory] 初始化失败：", err);
        });
      }
      return initPromise;
    };

    // getter 函数供 tools / cli / service API 使用
    const getStore = async (): Promise<MemoryStore | undefined> => {
      await ensureInitialized();
      return store;
    };
    const getRetriever = async (): Promise<Retriever | undefined> => {
      await ensureInitialized();
      return retriever;
    };
    const getCompactor = async (): Promise<Compactor | undefined> => {
      await ensureInitialized();
      return compactor;
    };

    // 立刻触发初始化（fire-and-forget，不阻塞 register）
    ensureInitialized();

    // ── 7. 自动采集 Hooks（autoCapture） ──────────────────────────────────
    if (autoCapture) {
      // after_tool_call → 采集工具调用
      api.on("after_tool_call", async (payload: Record<string, unknown>) => {
        try {
          await ensureInitialized();
          const ctx = resolveContext(payload);
          const packs = collector.collectFromToolCall(
            payload as unknown as import("./src/types/evidence").AfterToolCallEvent,
            ctx
          );

          if (router && packs.length > 0) {
            for (const pack of packs) {
              await router.route(pack);
            }
            log.info(`[memory] after_tool_call → ${packs.length} pack(s) routed`);
          }
        } catch (err) {
          log.error("[memory] after_tool_call hook 异常：", err);
        }
      });

      // agent_end → 采集本轮消息 + 阈值检查触发压缩
      api.on("agent_end", async (payload: Record<string, unknown>) => {
        try {
          await ensureInitialized();
          const ctx = resolveContext(payload);
          const packs = collector.collectFromAgentEnd(
            payload as unknown as import("./src/types/evidence").AgentEndEvent,
            ctx
          );

          if (router && packs.length > 0) {
            for (const pack of packs) {
              await router.route(pack);
            }
            log.info(`[memory] agent_end → ${packs.length} pack(s) routed`);
          }

          // 阈值检查：STM 条目数超限时触发压缩
          if (compactor && store && config.compactor.compaction.enableThresholdTrigger) {
            const stats = await store.getStats("stm").catch(() => ({ activeCount: 0 }));
            const maxEntries = config.compactor.stm.maxEntries;

            if (stats.activeCount > maxEntries * 1.2) {
              log.info(
                `[memory] STM 超限 (${stats.activeCount} > ${maxEntries * 1.2})，触发压缩`
              );
              await compactor.runFull().catch((err: unknown) => {
                log.warn("[memory] 阈值触发压缩失败：", err);
              });
            }
          }
        } catch (err) {
          log.error("[memory] agent_end hook 异常：", err);
        }
      });

      // before_compaction → 采集压缩前快照 + 触发压缩
      api.on("before_compaction", async (payload: Record<string, unknown>) => {
        try {
          await ensureInitialized();
          const ctx = resolveContext(payload);
          const packs = collector.collectFromCompaction(
            payload as unknown as import("./src/types/evidence").CompactionEvent,
            ctx
          );

          if (router && packs.length > 0) {
            for (const pack of packs) {
              await router.route(pack);
            }
            log.info(`[memory] before_compaction → ${packs.length} pack(s) routed`);
          }

          // 触发压缩
          if (compactor) {
            await compactor.runFull().catch((err: unknown) => {
              log.warn("[memory] before_compaction 压缩失败：", err);
            });
          }
        } catch (err) {
          log.error("[memory] before_compaction hook 异常：", err);
        }
      });

      // command:new → 采集新会话事件
      api.registerHook(["command:new"], async (ctx: Record<string, unknown>) => {
        try {
          await ensureInitialized();
          const event = {
            previousSessionId: ctx.previousSessionId as string | undefined,
            messageCount: ctx.messageCount as number | undefined,
          };
          const packs = collector.collectFromNewSession(event);

          if (router && packs.length > 0) {
            for (const pack of packs) {
              await router.route(pack);
            }
            log.info(`[memory] command:new → ${packs.length} pack(s) routed`);
          }
        } catch (err) {
          log.error("[memory] command:new hook 异常：", err);
        }
      });
    }

    // ── 8. 自动召回 Hook（autoRecall） ────────────────────────────────────
    if (autoRecall) {
      api.on("before_agent_start", async (payload: Record<string, unknown>) => {
        try {
          await ensureInitialized();
          if (!retriever) {
            log.info("[memory] before_agent_start → Retriever 未就绪，跳过 autoRecall");
            return;
          }

          // 提取最后一条用户消息
          const messages = (payload.messages as Array<{ role: string; content: string }>) ?? [];
          const lastUserMsg = messages.filter((m) => m.role === "user").slice(-1)[0];
          const query = lastUserMsg?.content ?? "";

          if (!query) {
            log.info("[memory] before_agent_start → 无查询内容，跳过 autoRecall");
            return;
          }

          // 检索相关记忆
          const result = await retriever.retrieve({ text: query, topK: 5 });

          if (result.entries.length > 0) {
            // 格式化记忆并注入 systemPromptExtra
            const memoryContext = formatMemoriesForContext(result.entries);
            payload.systemPromptExtra =
              ((payload.systemPromptExtra as string) ?? "") + "\n\n" + memoryContext;
            log.info(`[memory] before_agent_start → 注入 ${result.entries.length} 条相关记忆`);
          } else {
            log.info("[memory] before_agent_start → 未找到相关记忆");
          }
        } catch (err) {
          log.error("[memory] before_agent_start autoRecall 异常：", err);
        }
      });
    }

    // ── 9. 注册 Tools（模型 function call） ───────────────────────────────
    try {
      registerTools(api, { getStore, getRetriever });
      log.info(
        "[memory] Tools 已注册 (memory_recall, memory_store, memory_forget, memory_stats)"
      );
    } catch (err) {
      log.error("[memory] Tools 注册失败：", err);
    }

    // ── 10. 注册 CLI（人类运维命令） ──────────────────────────────────────
    try {
      registerCli(api, { getStore, getRetriever, getCompactor });
      log.info("[memory] CLI 已注册 (search, stats, compact, export, import, conflicts)");
    } catch (err) {
      log.error("[memory] CLI 注册失败：", err);
    }

    // ── 11. 可选：注册 Service API（供其他插件调用） ──────────────────────
    if (typeof api.registerService === "function") {
      try {
        api.registerService("memory", {
          recall: async (query: string, options?: Record<string, unknown>) => {
            const r = await getRetriever();
            if (!r) throw new Error("Memory not initialized");
            return r.retrieve({ text: query, ...(options || {}) }).then((res) => res.entries);
          },
          store: async (content: string, category: string, key?: string) => {
            const s = await getStore();
            if (!s) throw new Error("Memory not initialized");
            const { v4: uuidv4 } = await import("uuid");
            const entry = {
              id: uuidv4(),
              key: key || `${category}_${Date.now()}`,
              category,
              claim: content,
              confidence: 0.9,
              version: 1,
              createdAt: Date.now(),
              updatedAt: Date.now(),
              scope: "global",
              supersededBy: "",
              evidence: JSON.stringify([
                { sourceId: "service_api", sourceType: "service_api", extractedAt: Date.now() },
              ]),
              metadata: JSON.stringify({}),
            };
            return s.upsert("knowledge", entry.key, entry as never);
          },
          forget: async (key: string) => {
            const s = await getStore();
            if (!s) throw new Error("Memory not initialized");
            const entry = await s.getByKey("knowledge", key);
            if (entry) {
              await s.softDelete("knowledge", entry.id);
              return true;
            }
            return false;
          },
          getStats: async () => {
            const s = await getStore();
            if (!s) throw new Error("Memory not initialized");
            const tables = ["stm", "episodic", "knowledge", "entities", "relations"] as const;
            const stats: Record<string, unknown> = {};
            for (const table of tables) {
              stats[table] = await s.getStats(table);
            }
            return stats;
          },
        });
        log.info("[memory] Service API 已注册（供其他插件调用）");
      } catch (err) {
        log.warn("[memory] Service API 注册失败（可能不支持）：", err);
      }
    }
  },
};

// ─── 工具函数：格式化记忆为上下文 ───────────────────────────────────────────

function formatMemoriesForContext(entries: RetrievedEntry[]): string {
  const lines = entries.map((e) => `- [${e.layer}] ${e.content} (score: ${e.score.toFixed(3)})`);
  return `<relevant-memories>\n${lines.join("\n")}\n</relevant-memories>`;
}

// ─── 工具函数：从 Hook payload 提取 HookContext ────────────────────────────

function resolveContext(payload: Record<string, unknown>): HookContext {
  return {
    agentId: (payload.agentId as string) ?? (payload.agent_id as string) ?? "unknown",
    sessionKey:
      (payload.sessionKey as string) ?? (payload.session_key as string) ?? "session:unknown",
    envFingerprint: (payload.envFingerprint as HookContext["envFingerprint"]) ?? {},
  };
}

export default definition;
