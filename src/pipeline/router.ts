/**
 * MOD3: Layer Router（层级路由器）
 *
 * 职责：将 EvidencePack 分类并路由到正确的记忆层（STM/Episodic/Knowledge/Structural）。
 * 策略：rules_then_llm — 规则快路径优先，未命中时走 LLM 分类，LLM 失败自动降级 rules_only。
 */

import { v4 as uuidv4 } from "uuid";
import type { EvidencePack, Logger } from "../types/evidence";
import type {
  STMEntry,
  EpisodicEntry,
  KnowledgeEntry,
  EntityEntry,
  RelationEntry,
  MemoryStore,
} from "../store/types";
import { sha256Hex } from "../utils/hash";
import { truncateLog } from "../utils/truncate";

// ─── Types ────────────────────────────────────────────────────────────────────

export type LayerLabel = "stm" | "episodic" | "knowledge" | "structural" | "discard";

export interface ClassificationResult {
  layer: LayerLabel;
  subCategory: string;
  confidence: number;
  shouldPromote: boolean;
  extractedEntities?: string[];
  knowledgeKey?: string;
}

export interface RouterConfig {
  classifyMode: "rules_only" | "rules_then_llm" | "llm_only";
  llmModel: string;
  llmMaxTokens: number;
  stmTTLMs: number;
  minConfidenceForKnowledge: number;
  minConfidenceForStructural: number;
  batchSize: number;
  batchDelayMs: number;
}

export interface RouteResult {
  packId: string;
  layer: LayerLabel;
  entryId: string | null;
  promoted: boolean;
}

export interface LayerRouter {
  route(pack: EvidencePack): Promise<RouteResult>;
  routeBatch(packs: EvidencePack[]): Promise<RouteResult[]>;
  getStats(): {
    routed: Record<LayerLabel, number>;
    discarded: number;
    llmCalls: number;
  };
}

export const DEFAULT_ROUTER_CONFIG: RouterConfig = {
  classifyMode: "rules_then_llm",
  llmModel: "haiku",
  llmMaxTokens: 200,
  stmTTLMs: 3_600_000, // 1 hour
  minConfidenceForKnowledge: 0.7,
  minConfidenceForStructural: 0.8,
  batchSize: 5,
  batchDelayMs: 100,
};

// ─── LLM Classify Prompt ──────────────────────────────────────────────────────

const CLASSIFY_PROMPT = `你是记忆分类器。根据以下内容判断应存入哪一层记忆。

内容类型: {source}
内容摘要: {summary}
重要性评分: {importance}
标签: {tags}

分类选项:
1. stm - 临时上下文，1小时后可丢弃
2. episodic - 重要事件/操作记录，需长期保留
3. knowledge - 可复用的知识/偏好/规则
4. structural - 包含实体或关系信息
5. discard - 无价值内容

输出 JSON:
{
  "layer": "stm|episodic|knowledge|structural|discard",
  "subCategory": "...",
  "confidence": 0.0-1.0,
  "shouldPromote": false,
  "knowledgeKey": "...",
  "extractedEntities": []
}`;

// ─── Helper: Summarize ────────────────────────────────────────────────────────

function summarize(pack: EvidencePack): string {
  if (pack.toolCall) {
    const cmd = (pack.toolCall.args.command as string | undefined) ?? pack.toolCall.toolName;
    const status = pack.toolCall.result.ok ? "成功" : "失败";
    const cmdTrunc = truncateLog(cmd, 50);
    return `工具: ${pack.toolCall.toolName}, 命令: ${cmdTrunc}, 结果: ${status}`;
  }
  if (pack.message) {
    return truncateLog(pack.message.text, 100);
  }
  if (pack.sessionEvent) {
    return `会话事件: ${pack.sessionEvent.eventType}`;
  }
  return "无内容";
}

// ─── Phase 2: Classification Logic ───────────────────────────────────────────

/**
 * 规则快速路径：基于规则返回分类结果，未命中返回 null
 */
function ruleBasedClassify(pack: EvidencePack): ClassificationResult | null {
  // 1. 显式指令 → Knowledge
  if (pack.message?.text.match(/记住|remember|我(喜欢|偏好|习惯)/i)) {
    return {
      layer: "knowledge",
      subCategory: "preference",
      confidence: 0.95,
      shouldPromote: false,
    };
  }

  // 2. 工具调用失败 → Episodic
  if (pack.toolCall && !pack.toolCall.result.ok) {
    return {
      layer: "episodic",
      subCategory: "outcome",
      confidence: 0.9,
      shouldPromote: false,
    };
  }

  // 3. 会话事件 → Episodic
  if (pack.sessionEvent) {
    return {
      layer: "episodic",
      subCategory: "session",
      confidence: 0.95,
      shouldPromote: false,
    };
  }

  // 4. 短消息且非指令 → STM
  if (pack.message && pack.message.text.length < 100 && pack.importance < 0.5) {
    return {
      layer: "stm",
      subCategory: "context",
      confidence: 0.8,
      shouldPromote: false,
    };
  }

  return null;
}

/**
 * LLM 分类慢速路径：调用 LLM 服务，失败降级为 { layer: "stm", confidence: 0.5 }
 *
 * @param pack - EvidencePack
 * @param api - OpenClaw API (需要 api.services.llm)
 * @param config - Router 配置
 * @param logger - 日志接口
 */
async function llmClassify(
  pack: EvidencePack,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  api: any,
  config: RouterConfig,
  logger: Logger,
): Promise<ClassificationResult> {
  const fallback: ClassificationResult = {
    layer: "stm",
    subCategory: "context",
    confidence: 0.5,
    shouldPromote: false,
  };

  try {
    const prompt = CLASSIFY_PROMPT.replace("{source}", pack.source)
      .replace("{summary}", summarize(pack))
      .replace("{importance}", String(pack.importance))
      .replace("{tags}", pack.tags.join(", "));

    // LLM 接口调用 + 10s timeout
    // 假设接口：api.services.llm.complete({ model, prompt, responseFormat, maxTokens })
    // 如实际接口不同，需在此调整
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10_000);

    const response = await api.services.llm.complete({
      model: config.llmModel,
      prompt,
      responseFormat: "json",
      maxTokens: config.llmMaxTokens,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    // 解析 JSON 响应
    const parsed = JSON.parse(response);

    // 字段校验
    const validLayers = ["stm", "episodic", "knowledge", "structural", "discard"];
    if (!validLayers.includes(parsed.layer)) {
      logger.warn(`[router] LLM 返回未知 layer: ${parsed.layer}，降级为 stm`);
      return fallback;
    }

    const confidence = Number(parsed.confidence ?? 0.5);
    if (confidence < 0 || confidence > 1) {
      logger.warn(`[router] LLM 返回非法 confidence: ${confidence}，降级为 0.5`);
      return { ...parsed, confidence: 0.5, layer: parsed.layer as LayerLabel };
    }

    return {
      layer: parsed.layer as LayerLabel,
      subCategory: String(parsed.subCategory ?? ""),
      confidence,
      shouldPromote: Boolean(parsed.shouldPromote),
      knowledgeKey: parsed.knowledgeKey,
      extractedEntities: parsed.extractedEntities,
    };
  } catch (err) {
    logger.warn(`[router] LLM 分类失败，降级为 stm：${String(err)}`);
    return fallback;
  }
}

/**
 * 主分类函数：根据 classifyMode 选择策略
 */
async function classify(
  pack: EvidencePack,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  api: any,
  config: RouterConfig,
  logger: Logger,
): Promise<ClassificationResult> {
  let result: ClassificationResult | null = null;

  if (config.classifyMode === "rules_only") {
    result = ruleBasedClassify(pack);
    if (!result) {
      // 规则未命中，降级为 stm
      result = {
        layer: "stm",
        subCategory: "context",
        confidence: 0.5,
        shouldPromote: false,
      };
    }
  } else if (config.classifyMode === "rules_then_llm") {
    result = ruleBasedClassify(pack);
    if (!result) {
      result = await llmClassify(pack, api, config, logger);
    }
  } else {
    // llm_only
    result = await llmClassify(pack, api, config, logger);
  }

  // confidence 不够高的 knowledge/structural 降级为 episodic
  if (result.layer === "knowledge" && result.confidence < config.minConfidenceForKnowledge) {
    logger.info(
      `[router] knowledge confidence ${result.confidence} < ${config.minConfidenceForKnowledge}，降级为 episodic`,
    );
    result.layer = "episodic";
    result.subCategory = "message";
  }

  if (result.layer === "structural" && result.confidence < config.minConfidenceForStructural) {
    logger.info(
      `[router] structural confidence ${result.confidence} < ${config.minConfidenceForStructural}，降级为 episodic`,
    );
    result.layer = "episodic";
    result.subCategory = "message";
  }

  return result;
}

// ─── Phase 3: Entity Conversion ──────────────────────────────────────────────

/**
 * 派生 Chain ID：sha256(intentKey:targetKey:errorClass).slice(0,16)
 */
function deriveChainId(pack: EvidencePack): string {
  const errorClass =
    pack.toolCall && !pack.toolCall.result.ok
      ? extractErrorClass(pack.toolCall.result.stderr)
      : "success";
  const parts = [pack.intentKey, pack.targetKey, errorClass];
  return sha256Hex(parts.join(":"));
}

/**
 * 从 stderr 提取错误类别（简单规则：优先找 Error 类名，否则返回空）
 */
function extractErrorClass(stderr?: string): string {
  if (!stderr) return "";
  const match = stderr.match(/(\w+Error):/);
  return match ? match[1] : "";
}

/**
 * 派生 Knowledge Key：基于 intentKey + 消息特征
 */
function deriveKnowledgeKey(pack: EvidencePack): string {
  const base = pack.intentKey;
  if (pack.message) {
    const textHash = sha256Hex(pack.message.text);
    return `${base}:${textHash}`;
  }
  return `${base}:${pack.id}`;
}

/**
 * EvidencePack → STMEntry
 */
function toSTMEntry(
  pack: EvidencePack,
  result: ClassificationResult,
  config: RouterConfig,
): STMEntry {
  return {
    id: pack.id,
    sessionKey: pack.sessionKey,
    content: summarize(pack),
    vector: [],
    category: (result.subCategory || "context") as STMEntry["category"],
    createdAt: pack.timestamp,
    expiresAt: pack.timestamp + config.stmTTLMs,
    importance: pack.importance,
    metadata: JSON.stringify({ source: pack.source, tags: pack.tags }),
  };
}

/**
 * EvidencePack → EpisodicEntry
 */
function toEpisodicEntry(pack: EvidencePack, result: ClassificationResult): EpisodicEntry {
  const chainId = deriveChainId(pack);
  const outcomeObj = pack.toolCall
    ? {
        success: pack.toolCall.result.ok,
        errorClass: extractErrorClass(pack.toolCall.result.stderr),
        recoveryAction: undefined,
      }
    : undefined;

  return {
    id: pack.id,
    chainId,
    eventType: (result.subCategory || "message") as EpisodicEntry["eventType"],
    content: summarize(pack),
    vector: [],
    intentKey: pack.intentKey,
    targetKey: pack.targetKey,
    timestamp: pack.timestamp,
    sessionKey: pack.sessionKey,
    outcome: JSON.stringify(outcomeObj ?? {}),
    metadata: JSON.stringify({ envFingerprint: pack.envFingerprint }),
  };
}

/**
 * EvidencePack → KnowledgeEntry
 */
function toKnowledgeEntry(pack: EvidencePack, result: ClassificationResult): KnowledgeEntry {
  const key = result.knowledgeKey || deriveKnowledgeKey(pack);
  const evidenceObj = [
    {
      sourceId: pack.id,
      sourceType: pack.source === "message" ? "user_explicit" : "episodic",
      extractedAt: Date.now(),
    },
  ];

  return {
    id: uuidv4(),
    key,
    category: (result.subCategory || "fact") as KnowledgeEntry["category"],
    claim: summarize(pack),
    vector: [],
    evidence: JSON.stringify(evidenceObj),
    confidence: result.confidence,
    version: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    supersededBy: "",
    scope: pack.sessionKey.includes("project:") ? extractProjectScope(pack) : "global",
    metadata: "{}",
  };
}

/**
 * 从 sessionKey 提取 project scope（简单实现）
 */
function extractProjectScope(pack: EvidencePack): string {
  const match = pack.sessionKey.match(/project:([^:]+)/);
  return match ? `project:${match[1]}` : "global";
}

/**
 * 提取实体和关系（Structural 层）
 *
 * 基于 ClassificationResult.extractedEntities 创建/更新 EntityEntry
 * 暂无 LLM 关系推理，relations 为空数组
 */
async function extractStructural(
  pack: EvidencePack,
  result: ClassificationResult,
  store: MemoryStore,
  logger: Logger,
): Promise<{ entities: EntityEntry[]; relations: RelationEntry[] }> {
  const entities: EntityEntry[] = [];
  const relations: RelationEntry[] = [];

  if (!result.extractedEntities?.length) {
    return { entities, relations };
  }

  for (const name of result.extractedEntities) {
    const normalizedName = normalizeEntityName(name);
    try {
      const existing = await store.getByKey<EntityEntry>("entities", normalizedName);

      if (existing) {
        // 更新已有实体
        await store.update("entities", existing.id, {
          lastSeen: Date.now(),
          mentionCount: existing.mentionCount + 1,
        });
      } else {
        // 创建新实体
        const newEntity: EntityEntry = {
          id: uuidv4(),
          entityType: inferEntityType(name, pack),
          name: normalizedName,
          aliases: JSON.stringify([name]),
          vector: [],
          attributes: "{}",
          firstSeen: Date.now(),
          lastSeen: Date.now(),
          mentionCount: 1,
          scope: "global",
          metadata: JSON.stringify({ source: pack.id }),
        };
        entities.push(newEntity);
      }
    } catch (err) {
      logger.warn(`[router] extractStructural 查询实体失败: ${name}`, err);
    }
  }

  return { entities, relations };
}

/**
 * 规范化实体名称：小写 + 去除空格
 */
function normalizeEntityName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "_");
}

/**
 * 推理实体类型（简单规则）
 */
function inferEntityType(name: string, pack: EvidencePack): EntityEntry["entityType"] {
  const lower = name.toLowerCase();
  if (
    lower.includes("file") ||
    lower.endsWith(".ts") ||
    lower.endsWith(".js") ||
    lower.endsWith(".json")
  ) {
    return "file";
  }
  if (lower.includes("repo") || lower.includes("project")) return "project";
  if (lower.includes("tool") || pack.toolCall) return "tool";
  if (lower.match(/^[A-Z][a-z]+ [A-Z][a-z]+$/)) return "person"; // 简单姓名检测
  return "concept";
}

// ─── Phase 4: Router Factory ─────────────────────────────────────────────────

/**
 * 创建 Layer Router 实例
 *
 * @param config - Router 配置
 * @param store - MemoryStore 实例
 * @param api - OpenClaw API (需要 api.services.llm)
 * @param logger - 日志接口
 */
export function createLayerRouter(
  config: Partial<RouterConfig>,
  store: MemoryStore,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  api: any,
  logger: Logger,
): LayerRouter {
  const cfg: RouterConfig = { ...DEFAULT_ROUTER_CONFIG, ...config };

  // 统计计数器
  const stats = {
    routed: {
      stm: 0,
      episodic: 0,
      knowledge: 0,
      structural: 0,
      discard: 0,
    } as Record<LayerLabel, number>,
    discarded: 0,
    llmCalls: 0,
  };

  /**
   * 路由单条 EvidencePack
   */
  async function route(pack: EvidencePack): Promise<RouteResult> {
    try {
      // 1. 分类
      const result = await classify(pack, api, cfg, logger);
      if (cfg.classifyMode !== "rules_only") {
        stats.llmCalls++;
      }

      // 2. discard 直接返回
      if (result.layer === "discard") {
        stats.routed.discard++;
        stats.discarded++;
        return { packId: pack.id, layer: "discard", entryId: null, promoted: false };
      }

      // 3. 转换并写入
      let entryId: string | null = null;
      const maxRetries = 2;
      const retryDelayMs = 500;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          if (result.layer === "stm") {
            const entry = toSTMEntry(pack, result, cfg);
            entryId = await store.insert("stm", entry);
          } else if (result.layer === "episodic") {
            const entry = toEpisodicEntry(pack, result);
            entryId = await store.insert("episodic", entry);
          } else if (result.layer === "knowledge") {
            const entry = toKnowledgeEntry(pack, result);
            entryId = await store.insert("knowledge", entry);
          } else if (result.layer === "structural") {
            const { entities } = await extractStructural(pack, result, store, logger);
            if (entities.length > 0) {
              const ids = await store.bulkInsert("entities", entities);
              entryId = ids[0] ?? null;
            }
          }

          break; // 成功写入，跳出重试循环
        } catch (err) {
          if (attempt < maxRetries) {
            logger.warn(`[router] 写入失败，重试 ${attempt + 1}/${maxRetries}：${String(err)}`);
            await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
          } else {
            logger.error(`[router] 写入最终失败，丢弃 pack ${pack.id}：${String(err)}`);
            stats.discarded++;
            return { packId: pack.id, layer: result.layer, entryId: null, promoted: false };
          }
        }
      }

      // 4. 更新统计
      stats.routed[result.layer]++;

      return {
        packId: pack.id,
        layer: result.layer,
        entryId,
        promoted: result.shouldPromote,
      };
    } catch (err) {
      logger.error(`[router] route 异常：${String(err)}`);
      stats.discarded++;
      return { packId: pack.id, layer: "discard", entryId: null, promoted: false };
    }
  }

  /**
   * 批量路由：按 batchSize 分批，每批间 batchDelayMs 延迟
   */
  async function routeBatch(packs: EvidencePack[]): Promise<RouteResult[]> {
    const results: RouteResult[] = [];

    for (let i = 0; i < packs.length; i += cfg.batchSize) {
      const batch = packs.slice(i, i + cfg.batchSize);
      const batchResults = await Promise.all(batch.map((p) => route(p)));
      results.push(...batchResults);

      // 批次间延迟
      if (i + cfg.batchSize < packs.length) {
        await new Promise((resolve) => setTimeout(resolve, cfg.batchDelayMs));
      }
    }

    return results;
  }

  /**
   * 获取统计
   */
  function getStats() {
    return {
      routed: { ...stats.routed },
      discarded: stats.discarded,
      llmCalls: stats.llmCalls,
    };
  }

  return { route, routeBatch, getStats };
}
