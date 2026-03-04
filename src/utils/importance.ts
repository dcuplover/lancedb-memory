import type { EvidencePack } from "../types/evidence";

/**
 * 为 EvidencePack 计算初步重要性分数（0~1）。
 *
 * 打分规则（可叠加，上限 1.0）：
 * - 基线：0.3
 * - 消息含"记住 / remember / 重要 / important"：+0.4
 * - 工具调用结果失败（ok=false）：+0.2
 * - 工具调用耗时超过 10 秒：+0.1
 */
export function computeInitialImportance(pack: EvidencePack): number {
  let score = 0.3;

  if (pack.message?.text.match(/记住|remember|重要|important/i)) {
    score += 0.4;
  }
  if (pack.toolCall?.result.ok === false) {
    score += 0.2;
  }
  if (pack.toolCall !== undefined && pack.toolCall.durationMs > 10_000) {
    score += 0.1;
  }

  return Math.min(1, score);
}
