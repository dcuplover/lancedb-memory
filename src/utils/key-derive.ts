import type { EvidencePack } from "../types/evidence";

/**
 * 将路径中的家目录前缀替换为 "~"，避免暴露用户名。
 * 支持 Linux/macOS (/home/<user> 或 /Users/<user>) 及 Windows (C:\Users\<user>\...)。
 */
export function normalizePath(p: string): string {
  return p
    .replace(/^\/(?:home|Users)\/[^/]+/, "~")
    .replace(/^[A-Za-z]:\\Users\\[^\\]+/, "~");
}

/**
 * 从 EvidencePack 派生语义意图键（intentKey）。
 *
 * 格式规则：
 * - tool_call → "<toolName>_<cmd_token1>_<token2>_<token3>"（小写，最多 3 个命令词）
 * - session_event → "session_<eventType>"
 * - message → "message_general"
 */
export function deriveIntentKey(pack: EvidencePack): string {
  if (pack.toolCall) {
    const cmd =
      (pack.toolCall.args.command as string | undefined) ?? pack.toolCall.toolName;
    const tokens = cmd
      .replace(/[^a-zA-Z0-9_\s]/g, " ")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 3);
    return `${pack.toolCall.toolName}_${tokens.join("_")}`.toLowerCase();
  }
  if (pack.sessionEvent) return `session_${pack.sessionEvent.eventType}`;
  return "message_general";
}

/**
 * 从 EvidencePack 派生目标键（targetKey），表示事件作用的对象。
 *
 * 优先级：path → repo → url → "general"
 */
export function deriveTargetKey(pack: EvidencePack): string {
  if (pack.toolCall) {
    const args = pack.toolCall.args;
    if (args.path) return `file:${normalizePath(String(args.path))}`;
    if (args.repo) return `repo:${String(args.repo)}`;
    if (args.url) {
      try {
        return `url:${new URL(String(args.url)).hostname}`;
      } catch {
        return "general";
      }
    }
  }
  return "general";
}
