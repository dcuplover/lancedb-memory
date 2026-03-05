/**
 * MOD6: Tools 注册（模型 function call）
 *
 * 注册 4 个 Tool：memory_recall, memory_store, memory_forget, memory_stats
 */

import { Type } from "@sinclair/typebox";
import type { MemoryStore, KnowledgeEntry } from "./store/types";
import type { Retriever, RetrievalQuery } from "./retrieval/types";
import { withTimeout, withRetry, SlidingWindowLimiter, validateInput } from "./utils/safety";
import { v4 as uuidv4 } from "uuid";

// ─── 写入限流器（5分钟内最多 20 次） ──────────────────────────────────────────

const writeLimiter = new SlidingWindowLimiter(20, 5 * 60 * 1000);

// ─── Tool 注册依赖接口 ────────────────────────────────────────────────────────

export interface ToolDependencies {
  getStore: () => Promise<MemoryStore | undefined>;
  getRetriever: () => Promise<Retriever | undefined>;
}

// ─── registerTools 主函数 ─────────────────────────────────────────────────────

/**
 * 注册所有 Tool 到 OpenClaw 插件 API。
 *
 * @param api   OpenClaw 插件 API 对象
 * @param deps  依赖项（getStore, getRetriever getter 函数，延迟初始化）
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerTools(api: any, deps: ToolDependencies): void {
  const { getStore, getRetriever } = deps;

  // ────────────────────────────────────────────────────────────────────────────
  // memory_recall: 检索相关记忆
  // ────────────────────────────────────────────────────────────────────────────
  api.registerTool(
    {
      name: "memory_recall",
      label: "检索记忆",
      description:
        "从四层记忆系统中检索相关信息。当用户询问过去讨论过的内容、偏好、决策或事实时使用。",
      importance: 0.9,
      parameters: Type.Object({
        query: Type.String({
          description: "自然语言查询，描述要检索的内容",
        }),
        layers: Type.Optional(
          Type.Array(Type.String(), {
            description: "限制检索层（可选值：stm, episodic, knowledge, structural）",
          })
        ),
        topK: Type.Optional(
          Type.Number({
            description: "返回结果数量（默认 5）",
            default: 5,
            minimum: 1,
            maximum: 50,
          })
        ),
      }),
      execute: async (_toolCallId: string, params: Record<string, unknown>) => {
        try {
          // 输入校验
          validateInput({ query: params.query as string });

          const retriever = await getRetriever();
          if (!retriever) {
            return { success: false, memories: [], error: "Memory system not initialized" };
          }

          const query: RetrievalQuery = {
            text: params.query as string,
            layers: (params.layers as string[]) as RetrievalQuery["layers"],
            topK: (params.topK as number) || 5,
          };

          // 检索（带超时 10s + 重试 3 次 + 降级返回空结果）
          const result = await withTimeout(
            () =>
              withRetry(
                () => retriever.retrieve(query),
                3,
                500
              ),
            10000,
            { entries: [], totalCount: 0, queryTimeMs: 0, layerBreakdown: {} }
          );

          // 格式化结果
          return {
            success: true,
            memories: result.entries.map((e) => ({
              layer: e.layer,
              content: e.content,
              score: parseFloat(e.score.toFixed(3)),
              metadata: e.metadata,
            })),
            totalFound: result.totalCount,
          };
        } catch (err) {
          api.log?.error?.("[memory_recall] Failed:", err);
          return {
            success: false,
            memories: [],
            error: err instanceof Error ? err.message : "Internal error",
          };
        }
      },
    },
    { name: "memory_recall" }
  );

  // ────────────────────────────────────────────────────────────────────────────
  // memory_store: 存储记忆
  // ────────────────────────────────────────────────────────────────────────────
  api.registerTool(
    {
      name: "memory_store",
      label: "存储记忆",
      description:
        "将信息存入长期记忆。当用户分享重要事实、偏好、决策或经验教训时使用。",
      importance: 0.8,
      parameters: Type.Object({
        content: Type.String({
          description: "要记住的内容，保持简洁和事实性",
        }),
        category: Type.String({
          description: "记忆类型：preference（偏好）, fact（事实）, rule（规则）, decision（决策）",
          enum: ["preference", "fact", "rule", "decision"],
          default: "fact",
        }),
        key: Type.Optional(
          Type.String({
            description: "唯一键（用于更新已有记忆，可选）",
          })
        ),
      }),
      execute: async (_toolCallId: string, params: Record<string, unknown>) => {
        try {
          // 输入校验
          const content = (params.content as string) || "";
          validateInput({ content });

          if (!content.trim()) {
            return { success: false, error: "Content cannot be empty" };
          }

          // 限流检查
          if (!writeLimiter.canProceed()) {
            api.log?.warn?.("[memory_store] Rate limit exceeded");
            return { success: false, error: "Rate limit exceeded (max 20 writes per 5 min)" };
          }

          const store = await getStore();
          if (!store) {
            return { success: false, error: "Memory system not initialized" };
          }

          const category = (params.category as string) || "fact";
          const key = (params.key as string) || generateKey(content, category);

          // 构造 Knowledge Entry
          const entry: Partial<KnowledgeEntry> = {
            id: uuidv4(),
            key,
            category: category as KnowledgeEntry["category"],
            claim: content,
            confidence: 0.9,
            version: 1,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            scope: "global",
            supersededBy: "",
            evidence: JSON.stringify([
              {
                sourceId: "user_explicit",
                sourceType: "user_explicit",
                extractedAt: Date.now(),
              },
            ]),
            metadata: JSON.stringify({}),
          };

          // 写入（带超时 10s + 重试 3 次）
          const id = await withTimeout(
            () =>
              withRetry(
                () => store.upsert("knowledge", key, entry as KnowledgeEntry),
                3,
                500
              ),
            10000,
            null
          );

          if (!id) {
            return { success: false, error: "Write timeout" };
          }

          return {
            success: true,
            id,
            message: `已记住: ${content.slice(0, 50)}${content.length > 50 ? "..." : ""}`,
          };
        } catch (err) {
          api.log?.error?.("[memory_store] Failed:", err);
          return {
            success: false,
            error: err instanceof Error ? err.message : "Internal error",
          };
        }
      },
    },
    { name: "memory_store" }
  );

  // ────────────────────────────────────────────────────────────────────────────
  // memory_forget: 删除记忆
  // ────────────────────────────────────────────────────────────────────────────
  api.registerTool(
    {
      name: "memory_forget",
      label: "删除记忆",
      description: "删除指定的记忆条目。当用户要求忘记某些信息时使用。",
      importance: 0.7,
      parameters: Type.Object({
        key: Type.Optional(
          Type.String({
            description: "记忆唯一键",
          })
        ),
        id: Type.Optional(
          Type.String({
            description: "记忆 ID",
          })
        ),
      }),
      execute: async (_toolCallId: string, params: Record<string, unknown>) => {
        try {
          const key = params.key as string | undefined;
          const id = params.id as string | undefined;

          if (!key && !id) {
            return { success: false, error: "Must provide either key or id" };
          }

          const store = await getStore();
          if (!store) {
            return { success: false, error: "Memory system not initialized" };
          }

          // 通过 key 查找
          if (key) {
            const entry = await withTimeout(
              () => store.getByKey("knowledge", key),
              5000,
              null
            );
            if (entry) {
              await store.softDelete("knowledge", entry.id);
              return { success: true, message: `已忘记: ${key}` };
            } else {
              return { success: false, error: `Memory with key "${key}" not found` };
            }
          }

          // 通过 id 删除
          if (id) {
            await withTimeout(() => store.softDelete("knowledge", id), 5000, null);
            return { success: true, message: `已删除: ${id}` };
          }

          return { success: false, error: "No valid identifier provided" };
        } catch (err) {
          api.log?.error?.("[memory_forget] Failed:", err);
          return {
            success: false,
            error: err instanceof Error ? err.message : "Internal error",
          };
        }
      },
    },
    { name: "memory_forget" }
  );

  // ────────────────────────────────────────────────────────────────────────────
  // memory_stats: 记忆统计
  // ────────────────────────────────────────────────────────────────────────────
  api.registerTool(
    {
      name: "memory_stats",
      label: "记忆统计",
      description: "获取记忆系统的统计信息，包括各层存储的记忆数量。",
      importance: 0.5,
      parameters: Type.Object({}),
      execute: async (_toolCallId: string, _params: Record<string, unknown>) => {
        try {
          const store = await getStore();
          if (!store) {
            return { success: false, error: "Memory system not initialized" };
          }

          const tables = ["stm", "episodic", "knowledge", "entities", "relations"] as const;
          const stats: Record<string, unknown> = {};

          for (const table of tables) {
            try {
              const tableStat = await withTimeout(() => store.getStats(table), 3000, null);
              if (tableStat) {
                stats[table] = {
                  total: tableStat.rowCount,
                  active: tableStat.activeCount,
                  deleted: tableStat.softDeletedCount,
                };
              }
            } catch {
              stats[table] = { error: "Failed to fetch" };
            }
          }

          return { success: true, stats };
        } catch (err) {
          api.log?.error?.("[memory_stats] Failed:", err);
          return {
            success: false,
            error: err instanceof Error ? err.message : "Internal error",
          };
        }
      },
    },
    { name: "memory_stats" }
  );
}

// ─── 辅助函数：生成记忆键 ─────────────────────────────────────────────────────

function generateKey(content: string, category: string): string {
  // 简单的键生成策略：category + 内容前 30 字符的 hash
  const prefix = category.slice(0, 4);
  const snippet = content.slice(0, 30).replace(/[^a-zA-Z0-9]/g, "_");
  const timestamp = Date.now().toString(36);
  return `${prefix}_${snippet}_${timestamp}`;
}
