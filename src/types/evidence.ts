// ─── Evidence Source ──────────────────────────────────────────────────────────

export type EvidenceSource = "tool_call" | "message" | "session_event";

// ─── Evidence Pack ────────────────────────────────────────────────────────────

/** 证据包：采集器输出的原子单元，交给 LayerRouter 分类路由 */
export interface EvidencePack {
  id: string;                // UUID v4
  timestamp: number;         // Date.now()
  sessionKey: string;        // "agent:<agentId>:project:<hash>"
  agentId: string;           // 当前 agent 标识
  source: EvidenceSource;    // 来源类型

  // ── 业务键（用于事件链串联）──
  intentKey: string;         // 如 "bash_exec_npm_publish"
  targetKey: string;         // 如 "repo:ui-sdk" / "file:src/index.ts"

  // ── 工具调用（source="tool_call" 时填充）──
  toolCall?: {
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;  // 脱敏后
    argsHash: string;               // SHA-256 前 16 位
    result: {
      ok: boolean;
      exitCode?: number;
      stdout?: string;              // 截断至 maxLogChars
      stderr?: string;              // 截断至 maxLogChars
      outputHash: string;
    };
    durationMs: number;
  };

  // ── 消息（source="message" 时填充）──
  message?: {
    role: "user" | "assistant";
    text: string;                   // 截断至 2000 字符
    messageIndex: number;
  };

  // ── 会话事件（source="session_event" 时填充）──
  sessionEvent?: {
    eventType: "new" | "reset" | "compaction" | "end";
    previousSessionId?: string;
    messageCount?: number;
  };

  // ── 环境指纹 ──
  envFingerprint: {
    branch?: string;
    commitHash?: string;
    configHash?: string;
  };

  // ── 初步元数据 ──
  tags: string[];              // 如 ["error:429", "tool:bash_exec"]
  importance: number;          // 0~1
}

// ─── Collector Config ─────────────────────────────────────────────────────────

export interface CollectorConfig {
  enabled: boolean;
  maxLogChars: number;                 // 默认 800
  redactKeys: string[];                // 默认 ["apiKey","token","password","secret"]
  dedupeWindowMs: number;              // 默认 300_000 (5min)
  excludeTools: string[];              // 默认 ["memory_recall","memory_store","memory_forget"]
  minMessageLength: number;            // 默认 5
  minMessageLengthCJK: number;         // 默认 3
  maxEvidencePerAgentEnd: number;      // 默认 10
  compactionSnapshotMessages: number;  // 默认 20
}

// ─── Hook Event Input Types ───────────────────────────────────────────────────

/** after_tool_call Hook 的事件载荷 */
export interface AfterToolCallEvent {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  result: {
    ok: boolean;
    exitCode?: number;
    stdout?: string;
    stderr?: string;
  };
  durationMs: number;
}

export interface AgentMessage {
  role: "user" | "assistant";
  text: string;
}

/** agent_end Hook 的事件载荷 */
export interface AgentEndEvent {
  messages: AgentMessage[];
  messageCount?: number;
}

/** before_compaction Hook 的事件载荷 */
export interface CompactionEvent {
  messages: AgentMessage[];
  messageCount?: number;
}

/** command:new Internal Hook 的事件载荷 */
export interface NewSessionEvent {
  previousSessionId?: string;
  messageCount?: number;
}

// ─── Hook Context ─────────────────────────────────────────────────────────────

/** 从 OpenClaw Hook 中提取的 Agent/Session 上下文 */
export interface HookContext {
  agentId: string;
  sessionKey: string;
  envFingerprint?: {
    branch?: string;
    commitHash?: string;
    configHash?: string;
  };
}

// ─── Collector Stats ──────────────────────────────────────────────────────────

export interface CollectorStats {
  collected: number;
  filtered: number;
  deduped: number;
}

// ─── EventCollector Interface ─────────────────────────────────────────────────

export interface EventCollector {
  collectFromToolCall(event: AfterToolCallEvent, ctx: HookContext): EvidencePack[];
  collectFromAgentEnd(event: AgentEndEvent, ctx: HookContext): EvidencePack[];
  collectFromCompaction(event: CompactionEvent, ctx: HookContext): EvidencePack[];
  /** command:new 没有 agent 上下文，sessionKey 取 previousSessionId */
  collectFromNewSession(event: NewSessionEvent): EvidencePack[];

  getStats(): CollectorStats;
  resetStats(): void;
}

// ─── Logger Interface (matches openclaw api.log) ─────────────────────────────

export interface Logger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}
