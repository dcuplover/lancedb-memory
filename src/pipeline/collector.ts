import { v4 as uuidv4 } from "uuid";
import type {
  CollectorConfig,
  CollectorStats,
  EvidencePack,
  EventCollector,
  HookContext,
  AfterToolCallEvent,
  AgentEndEvent,
  CompactionEvent,
  NewSessionEvent,
  Logger,
} from "../types/evidence";
import { sha256Hex } from "../utils/hash";
import { redactSensitive } from "../utils/redact";
import { truncateLog } from "../utils/truncate";
import { LRUSet } from "../utils/lru-set";
import { deriveIntentKey, deriveTargetKey } from "../utils/key-derive";
import { computeInitialImportance } from "../utils/importance";

// ─── Default Config ───────────────────────────────────────────────────────────

export const DEFAULT_COLLECTOR_CONFIG: CollectorConfig = {
  enabled: true,
  maxLogChars: 800,
  redactKeys: ["apiKey", "token", "password", "secret"],
  dedupeWindowMs: 300_000,
  excludeTools: ["memory_recall", "memory_store", "memory_forget"],
  minMessageLength: 5,
  minMessageLengthCJK: 3,
  maxEvidencePerAgentEnd: 10,
  compactionSnapshotMessages: 20,
};

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * 创建 EventCollector 实例。
 *
 * @param config  部分配置，未提供的字段使用 DEFAULT_COLLECTOR_CONFIG 默认值
 * @param logger  日志接口（来自 OpenClaw api.log），不传则静默
 */
export function createEventCollector(
  config: Partial<CollectorConfig> = {},
  logger?: Logger,
): EventCollector {
  const cfg: CollectorConfig = { ...DEFAULT_COLLECTOR_CONFIG, ...config };
  const recentHashes = new LRUSet<string>(10_000);
  const stats: CollectorStats = { collected: 0, filtered: 0, deduped: 0 };

  const log: Logger = logger ?? {
    info: () => {},
    warn: () => {},
    error: () => {},
  };

  // ─── 消息长度检查 ──────────────────────────────────────────────────────────

  function isShortMessage(text: string): boolean {
    // 含 CJK 字符比例 > 30% 时按 CJK 最短长度判断
    const cjkCount =
      (text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) ?? []).length;
    const isCJK = text.length > 0 && cjkCount / text.length > 0.3;
    return isCJK
      ? text.length < cfg.minMessageLengthCJK
      : text.length < cfg.minMessageLength;
  }

  // ─── DROP_RULES ────────────────────────────────────────────────────────────

  function shouldDrop(pack: EvidencePack): boolean {
    // 1. 空消息或过短消息
    if (pack.message && isShortMessage(pack.message.text)) return true;
    // 2. 招呼语：直接丢弃
    if (pack.message && /^(hi|hello|ok|好的?|嗯)$/i.test(pack.message.text.trim()))
      return true;
    // 3. 排除的工具（防止采集 memory_* 工具造成循环）
    if (pack.toolCall && cfg.excludeTools.includes(pack.toolCall.toolName)) return true;
    return false;
  }

  // ─── 去重 ──────────────────────────────────────────────────────────────────

  function isDuplicate(pack: EvidencePack): boolean {
    let key: string;
    if (pack.toolCall) {
      key = `tc:${pack.intentKey}:${pack.toolCall.argsHash}:${pack.toolCall.result.outputHash}`;
    } else if (pack.message) {
      // 消息去重：基于 intentKey + 内容哈希，避免所有消息共用同一个 key
      key = `msg:${pack.intentKey}:${sha256Hex(pack.message.text)}`;
    } else {
      key = `se:${pack.intentKey}:${pack.sessionEvent?.eventType ?? ""}`;
    }

    if (recentHashes.has(key, cfg.dedupeWindowMs)) return true;
    recentHashes.add(key);
    return false;
  }

  // ─── Tags 构建 ─────────────────────────────────────────────────────────────

  function buildTags(pack: EvidencePack): string[] {
    const tags: string[] = [];
    if (pack.toolCall) {
      tags.push(`tool:${pack.toolCall.toolName}`);
      if (!pack.toolCall.result.ok) {
        const code = pack.toolCall.result.exitCode;
        tags.push(code !== undefined ? `error:${code}` : "error:unknown");
      }
    }
    if (pack.message?.text.match(/记住|remember|重要|important/i)) {
      tags.push("keyword:remember");
    }
    if (pack.sessionEvent) {
      tags.push(`session:${pack.sessionEvent.eventType}`);
    }
    return tags;
  }

  // ─── 基础字段（来自 HookContext）──────────────────────────────────────────

  function baseFields(
    ctx: HookContext,
  ): Pick<EvidencePack, "id" | "timestamp" | "sessionKey" | "agentId" | "envFingerprint"> {
    return {
      id: uuidv4(),
      timestamp: Date.now(),
      sessionKey: ctx.sessionKey,
      agentId: ctx.agentId,
      envFingerprint: ctx.envFingerprint ?? {},
    };
  }

  // ─── Pack 最终化：填充派生字段 + 过滤 ─────────────────────────────────────

  type PartialPack = Omit<EvidencePack, "intentKey" | "targetKey" | "importance" | "tags">;

  function finalizePack(partial: PartialPack): EvidencePack | null {
    const pack = partial as EvidencePack;

    // 派生业务键
    pack.intentKey = deriveIntentKey(pack);
    pack.targetKey = deriveTargetKey(pack);
    pack.importance = computeInitialImportance(pack);
    pack.tags = buildTags(pack);

    // 应用 DROP_RULES
    if (shouldDrop(pack)) {
      stats.filtered++;
      return null;
    }

    // 去重检查（在 shouldDrop 之后，避免为被过滤的 pack 占用 LRU 槽）
    if (isDuplicate(pack)) {
      stats.deduped++;
      return null;
    }

    stats.collected++;
    return pack;
  }

  // ─── 采集方法：after_tool_call ─────────────────────────────────────────────

  function collectFromToolCall(
    event: AfterToolCallEvent,
    ctx: HookContext,
  ): EvidencePack[] {
    if (!cfg.enabled) return [];
    try {
      const redactedArgs = redactSensitive(event.args, cfg.redactKeys);
      const argsHash = sha256Hex(JSON.stringify(event.args));

      const rawStdout = event.result.stdout ?? "";
      const rawStderr = event.result.stderr ?? "";
      const outputHash = sha256Hex(rawStdout + rawStderr);

      const partial: PartialPack = {
        ...baseFields(ctx),
        source: "tool_call",
        toolCall: {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: redactedArgs,
          argsHash,
          result: {
            ok: event.result.ok,
            exitCode: event.result.exitCode,
            stdout: truncateLog(rawStdout, cfg.maxLogChars),
            stderr: truncateLog(rawStderr, cfg.maxLogChars),
            outputHash,
          },
          durationMs: event.durationMs,
        },
      };

      const pack = finalizePack(partial);
      return pack ? [pack] : [];
    } catch (err) {
      log.warn("[EventCollector] collectFromToolCall 失败，跳过此条：", err);
      return [];
    }
  }

  // ─── 采集方法：agent_end ───────────────────────────────────────────────────

  function collectFromAgentEnd(
    event: AgentEndEvent,
    ctx: HookContext,
  ): EvidencePack[] {
    if (!cfg.enabled) return [];
    const packs: EvidencePack[] = [];
    const messages = event.messages.slice(-cfg.maxEvidencePerAgentEnd);
    const baseIndex = (event.messageCount ?? messages.length) - messages.length;

    for (let i = 0; i < messages.length; i++) {
      try {
        const msg = messages[i];
        const partial: PartialPack = {
          ...baseFields(ctx),
          source: "message",
          message: {
            role: msg.role,
            text: msg.text.slice(0, 2000),
            messageIndex: baseIndex + i,
          },
        };
        const pack = finalizePack(partial);
        if (pack) packs.push(pack);
      } catch (err) {
        log.warn("[EventCollector] collectFromAgentEnd 单条消息失败，跳过：", err);
      }
    }
    return packs;
  }

  // ─── 采集方法：before_compaction ──────────────────────────────────────────

  function collectFromCompaction(
    event: CompactionEvent,
    ctx: HookContext,
  ): EvidencePack[] {
    if (!cfg.enabled) return [];
    const packs: EvidencePack[] = [];

    // 1. 生成压缩会话事件包
    try {
      const sessionPartial: PartialPack = {
        ...baseFields(ctx),
        source: "session_event",
        sessionEvent: {
          eventType: "compaction",
          messageCount: event.messageCount,
        },
      };
      const sessionPack = finalizePack(sessionPartial);
      if (sessionPack) packs.push(sessionPack);
    } catch (err) {
      log.warn("[EventCollector] collectFromCompaction 会话事件包失败：", err);
    }

    // 2. 采集快照末尾的 M 条消息
    const messages = event.messages.slice(-cfg.compactionSnapshotMessages);
    for (let i = 0; i < messages.length; i++) {
      try {
        const msg = messages[i];
        const partial: PartialPack = {
          ...baseFields(ctx),
          source: "message",
          message: {
            role: msg.role,
            text: msg.text.slice(0, 2000),
            messageIndex: i,
          },
        };
        const pack = finalizePack(partial);
        if (pack) packs.push(pack);
      } catch (err) {
        log.warn("[EventCollector] collectFromCompaction 单条消息失败，跳过：", err);
      }
    }
    return packs;
  }

  // ─── 采集方法：command:new ─────────────────────────────────────────────────

  function collectFromNewSession(event: NewSessionEvent): EvidencePack[] {
    if (!cfg.enabled) return [];
    try {
      // command:new 时没有新 agent 上下文，用 previousSessionId 作为会话标识
      const ctx: HookContext = {
        agentId: "unknown",
        sessionKey: event.previousSessionId
          ? `session:${event.previousSessionId}`
          : "session:unknown",
        envFingerprint: {},
      };
      const partial: PartialPack = {
        ...baseFields(ctx),
        source: "session_event",
        sessionEvent: {
          eventType: "new",
          previousSessionId: event.previousSessionId,
          messageCount: event.messageCount,
        },
      };
      const pack = finalizePack(partial);
      return pack ? [pack] : [];
    } catch (err) {
      log.warn("[EventCollector] collectFromNewSession 失败：", err);
      return [];
    }
  }

  // ─── 统计 ──────────────────────────────────────────────────────────────────

  return {
    collectFromToolCall,
    collectFromAgentEnd,
    collectFromCompaction,
    collectFromNewSession,
    getStats: () => ({ ...stats }),
    resetStats: () => {
      stats.collected = 0;
      stats.filtered = 0;
      stats.deduped = 0;
    },
  };
}
