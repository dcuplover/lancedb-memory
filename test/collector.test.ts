import { describe, it, expect, beforeEach, vi } from "vitest";
import { createEventCollector, DEFAULT_COLLECTOR_CONFIG } from "../src/pipeline/collector";
import type {
  AfterToolCallEvent,
  AgentEndEvent,
  CompactionEvent,
  HookContext,
  NewSessionEvent,
} from "../src/types/evidence";

// ─── 公共测试数据 ─────────────────────────────────────────────────────────────

const mockCtx: HookContext = {
  agentId: "test-agent",
  sessionKey: "agent:test-agent:project:abc123",
  envFingerprint: { branch: "main", commitHash: "abc1234" },
};

function makeToolCallEvent(overrides: Partial<AfterToolCallEvent> = {}): AfterToolCallEvent {
  return {
    toolCallId: "tc-001",
    toolName: "bash_exec",
    args: { command: "npm test" },
    result: { ok: true, exitCode: 0, stdout: "PASS", stderr: "" },
    durationMs: 1200,
    ...overrides,
  };
}

function makeAgentEndEvent(
  texts: string[] = ["这是一条需要记录的消息"],
): AgentEndEvent {
  return {
    messages: texts.map((t, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      text: t,
    })),
    messageCount: texts.length,
  };
}

// ─── AC1：每种 Hook 事件都能产出格式正确的 EvidencePack ──────────────────────

describe("AC1：每种 Hook 事件产出格式正确的 EvidencePack", () => {
  const collector = createEventCollector();

  it("after_tool_call → source=tool_call，toolCall 字段完整", () => {
    const event = makeToolCallEvent();
    const packs = collector.collectFromToolCall(event, mockCtx);

    expect(packs).toHaveLength(1);
    const pack = packs[0];
    expect(pack.source).toBe("tool_call");
    expect(pack.agentId).toBe(mockCtx.agentId);
    expect(pack.sessionKey).toBe(mockCtx.sessionKey);
    expect(pack.toolCall).toBeDefined();
    expect(pack.toolCall!.toolName).toBe("bash_exec");
    expect(pack.toolCall!.toolCallId).toBe("tc-001");
    expect(pack.toolCall!.result.ok).toBe(true);
    expect(pack.toolCall!.durationMs).toBe(1200);
    expect(typeof pack.intentKey).toBe("string");
    expect(typeof pack.targetKey).toBe("string");
    expect(typeof pack.importance).toBe("number");
    expect(Array.isArray(pack.tags)).toBe(true);
    expect(typeof pack.id).toBe("string");
    expect(typeof pack.timestamp).toBe("number");
  });

  it("agent_end → source=message，message 字段完整", () => {
    const packs = collector.collectFromAgentEnd(
      makeAgentEndEvent(["这是用户的消息内容，足够长"]),
      mockCtx,
    );

    expect(packs.length).toBeGreaterThanOrEqual(1);
    const pack = packs[0];
    expect(pack.source).toBe("message");
    expect(pack.message).toBeDefined();
    expect(pack.message!.role).toMatch(/^(user|assistant)$/);
    expect(typeof pack.message!.text).toBe("string");
    expect(typeof pack.message!.messageIndex).toBe("number");
  });

  it("before_compaction → 含 session_event 包和消息包", () => {
    const compactionEvent: CompactionEvent = {
      messages: [
        { role: "user", text: "压缩前的最后几条消息——这是第一条" },
        { role: "assistant", text: "好的，我明白了这项任务的要求" },
      ],
      messageCount: 2,
    };
    const packs = collector.collectFromCompaction(compactionEvent, mockCtx);

    // 至少有一个 session_event 类型包
    const sessionPacks = packs.filter((p) => p.source === "session_event");
    expect(sessionPacks.length).toBeGreaterThanOrEqual(1);
    expect(sessionPacks[0].sessionEvent?.eventType).toBe("compaction");

    // 也包含消息包
    const msgPacks = packs.filter((p) => p.source === "message");
    expect(msgPacks.length).toBeGreaterThanOrEqual(1);
  });

  it("command:new → source=session_event，eventType=new", () => {
    const event: NewSessionEvent = {
      previousSessionId: "sess-old-001",
      messageCount: 42,
    };
    const packs = collector.collectFromNewSession(event);

    expect(packs).toHaveLength(1);
    const pack = packs[0];
    expect(pack.source).toBe("session_event");
    expect(pack.sessionEvent?.eventType).toBe("new");
    expect(pack.sessionEvent?.previousSessionId).toBe("sess-old-001");
    expect(pack.sessionEvent?.messageCount).toBe(42);
    expect(pack.intentKey).toBe("session_new");
  });
});

// ─── AC2：敏感字段已脱敏，日志已截断至 maxLogChars ───────────────────────────

describe("AC2：敏感字段脱敏 & 日志截断", () => {
  const collector = createEventCollector({ maxLogChars: 100 });

  it("args 中的 apiKey / token / password / secret 被替换为 [REDACTED]", () => {
    const event = makeToolCallEvent({
      args: {
        command: "curl https://example.com",
        apiKey: "sk-supersecret",
        token: "bearer-token",
        password: "p@ss",
        secret: "mysecret",
        safe: "visible",
      },
    });
    const [pack] = collector.collectFromToolCall(event, mockCtx);

    const args = pack.toolCall!.args;
    expect(args.apiKey).toBe("[REDACTED]");
    expect(args.token).toBe("[REDACTED]");
    expect(args.password).toBe("[REDACTED]");
    expect(args.secret).toBe("[REDACTED]");
    expect(args.safe).toBe("visible");
    expect(args.command).toBe("curl https://example.com");
  });

  it("嵌套对象中的敏感字段也被脱敏", () => {
    const event = makeToolCallEvent({
      args: {
        headers: { authorization: "bearer token", apiKey: "nested-key" },
      },
    });
    const [pack] = collector.collectFromToolCall(event, mockCtx);

    const headers = pack.toolCall!.args.headers as Record<string, unknown>;
    expect(headers.apiKey).toBe("[REDACTED]");
    // authorization 不在默认 redactKeys 中，不应被脱敏
    expect(headers.authorization).toBe("bearer token");
  });

  it("stdout 超过 maxLogChars 时被截断，含截断标记", () => {
    const longStdout = "A".repeat(200);
    const event = makeToolCallEvent({
      result: { ok: true, exitCode: 0, stdout: longStdout, stderr: "" },
    });
    const [pack] = collector.collectFromToolCall(event, mockCtx);

    const stdout = pack.toolCall!.result.stdout!;
    expect(stdout.length).toBeLessThan(longStdout.length);
    expect(stdout).toContain("…[truncated]…");
  });

  it("stderr 超过 maxLogChars 时被截断", () => {
    const longStderr = "E".repeat(200);
    const event = makeToolCallEvent({
      result: { ok: false, exitCode: 1, stdout: "", stderr: longStderr },
    });
    const [pack] = collector.collectFromToolCall(event, mockCtx);

    const stderr = pack.toolCall!.result.stderr!;
    expect(stderr).toContain("…[truncated]…");
  });
});

// ─── AC3：5 分钟内重复事件被去重 ─────────────────────────────────────────────

describe("AC3：5 分钟内重复事件被去重", () => {
  it("同一 tool_call 事件第二次发送时被去重", () => {
    const collector = createEventCollector({ dedupeWindowMs: 300_000 });
    const event = makeToolCallEvent({
      args: { command: "npm publish" },
      result: { ok: true, stdout: "published", stderr: "" },
    });

    const first = collector.collectFromToolCall(event, mockCtx);
    const second = collector.collectFromToolCall(event, mockCtx);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
    expect(collector.getStats().deduped).toBe(1);
  });

  it("超过去重窗口后，同一事件不再被去重", () => {
    vi.useFakeTimers();
    const collector = createEventCollector({ dedupeWindowMs: 1000 }); // 1 秒窗口
    const event = makeToolCallEvent();

    collector.collectFromToolCall(event, mockCtx);
    vi.advanceTimersByTime(1100); // 超过 1 秒窗口

    const packs = collector.collectFromToolCall(event, mockCtx);
    expect(packs).toHaveLength(1); // 窗口过期后，第二次应通过

    vi.useRealTimers();
  });

  it("不同 args 的 tool_call 不互相影响", () => {
    const collector = createEventCollector();
    const event1 = makeToolCallEvent({ args: { command: "npm test" } });
    const event2 = makeToolCallEvent({ args: { command: "npm build" } });

    const p1 = collector.collectFromToolCall(event1, mockCtx);
    const p2 = collector.collectFromToolCall(event2, mockCtx);

    expect(p1).toHaveLength(1);
    expect(p2).toHaveLength(1);
    expect(collector.getStats().deduped).toBe(0);
  });
});

// ─── AC4：采集失败不影响主对话流程 ───────────────────────────────────────────

describe("AC4：采集失败不抛出异常", () => {
  it("传入格式异常的 event 时，collectFromToolCall 返回空数组而非抛出", () => {
    const collector = createEventCollector();
    // 传入 null args 触发内部错误
    const badEvent = {
      toolCallId: "tc-bad",
      toolName: "broken_tool",
      args: null as unknown as Record<string, unknown>,
      result: { ok: false },
      durationMs: 0,
    };

    expect(() => collector.collectFromToolCall(badEvent, mockCtx)).not.toThrow();
    const packs = collector.collectFromToolCall(badEvent, mockCtx);
    expect(Array.isArray(packs)).toBe(true);
  });

  it("enabled=false 时，所有采集方法返回空数组", () => {
    const collector = createEventCollector({ enabled: false });

    expect(collector.collectFromToolCall(makeToolCallEvent(), mockCtx)).toHaveLength(0);
    expect(collector.collectFromAgentEnd(makeAgentEndEvent(), mockCtx)).toHaveLength(0);
    expect(
      collector.collectFromCompaction(
        { messages: [{ role: "user", text: "任意内容测试" }] },
        mockCtx,
      ),
    ).toHaveLength(0);
    expect(collector.collectFromNewSession({ previousSessionId: "s1" })).toHaveLength(0);
  });
});

// ─── AC5：显式"记住"指令的 importance > 0.7 ──────────────────────────────────

describe("AC5：'记住'消息的 importance > 0.7", () => {
  const collector = createEventCollector();

  const rememberPhrases = [
    "记住：部署前必须先跑测试",
    "remember: always use retry logic",
    "这很重要：需要在周五之前完成",
    "important: do not delete the config file",
  ];

  rememberPhrases.forEach((text) => {
    it(`"${text.slice(0, 20)}…" → importance > 0.7`, () => {
      const event = makeAgentEndEvent([text]);
      const packs = collector.collectFromAgentEnd(event, mockCtx);

      expect(packs).toHaveLength(1);
      expect(packs[0].importance).toBeGreaterThan(0.7);
    });
  });

  it("普通消息的 importance 在合理基线范围内（0.3~0.5）", () => {
    const event = makeAgentEndEvent(["这是一条普通的对话消息，不含特殊关键词"]);
    const packs = collector.collectFromAgentEnd(event, mockCtx);

    expect(packs).toHaveLength(1);
    expect(packs[0].importance).toBeGreaterThanOrEqual(0.3);
    expect(packs[0].importance).toBeLessThanOrEqual(0.5);
  });

  it("工具调用失败时 importance 自动提升（+0.2）", () => {
    const event = makeToolCallEvent({ result: { ok: false, exitCode: 1 } });
    const [pack] = collector.collectFromToolCall(event, mockCtx);

    expect(pack.importance).toBeGreaterThanOrEqual(0.5);
  });
});

// ─── AC6：getStats() 返回正确统计数据 ────────────────────────────────────────

describe("AC6：getStats() 统计准确", () => {
  let collector: ReturnType<typeof createEventCollector>;

  beforeEach(() => {
    collector = createEventCollector();
  });

  it("初始状态 stats 全为 0", () => {
    const stats = collector.getStats();
    expect(stats.collected).toBe(0);
    expect(stats.filtered).toBe(0);
    expect(stats.deduped).toBe(0);
  });

  it("成功采集后 collected 递增", () => {
    collector.collectFromToolCall(makeToolCallEvent(), mockCtx);
    expect(collector.getStats().collected).toBe(1);
  });

  it("被 DROP_RULES 过滤的 pack 计入 filtered", () => {
    // 招呼语被过滤
    const event = makeAgentEndEvent(["嗯"]);
    collector.collectFromAgentEnd(event, mockCtx);
    expect(collector.getStats().filtered).toBeGreaterThanOrEqual(1);
  });

  it("去重的 pack 计入 deduped，而非 collected", () => {
    const event = makeToolCallEvent();
    collector.collectFromToolCall(event, mockCtx); // collected +1
    collector.collectFromToolCall(event, mockCtx); // deduped +1

    const stats = collector.getStats();
    expect(stats.collected).toBe(1);
    expect(stats.deduped).toBe(1);
  });

  it("resetStats() 后所有统计归零", () => {
    collector.collectFromToolCall(makeToolCallEvent(), mockCtx);
    collector.resetStats();

    const stats = collector.getStats();
    expect(stats.collected).toBe(0);
    expect(stats.filtered).toBe(0);
    expect(stats.deduped).toBe(0);
  });

  it("excludeTools 中的工具被过滤，计入 filtered", () => {
    const event = makeToolCallEvent({ toolName: "memory_store" });
    collector.collectFromToolCall(event, mockCtx);

    expect(collector.getStats().filtered).toBe(1);
    expect(collector.getStats().collected).toBe(0);
  });
});

// ─── 额外：DROP_RULES 细节验证 ───────────────────────────────────────────────

describe("DROP_RULES：过滤规则细节", () => {
  const collector = createEventCollector();

  it("短消息（< minMessageLength）被过滤", () => {
    const event = makeAgentEndEvent(["hi"]);
    collector.collectFromAgentEnd(event, mockCtx);
    expect(collector.getStats().filtered).toBeGreaterThanOrEqual(1);
  });

  it("招呼语（hi/hello/ok/好的/嗯）被过滤", () => {
    ["hi", "Hello", "ok", "好的", "嗯"].forEach((text) => {
      const c = createEventCollector();
      const event = makeAgentEndEvent([text]);
      c.collectFromAgentEnd(event, mockCtx);
      expect(c.getStats().filtered).toBeGreaterThanOrEqual(1);
    });
  });

  it("正常长度消息不被过滤（由 collected 计入）", () => {
    const event = makeAgentEndEvent(["这是一条足够长的测试消息，用于验证正常采集路径"]);
    collector.collectFromAgentEnd(event, mockCtx);
    expect(collector.getStats().collected).toBeGreaterThanOrEqual(1);
  });
});
