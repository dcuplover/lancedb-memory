/**
 * 将字符串截断到 maxChars 以内。
 * 保留首尾各一半，中间插入截断标记 "\n…[truncated]…\n"，
 * 确保输出总长度约为 maxChars（不计标记本身长度）。
 *
 * @param text     原始字符串
 * @param maxChars 最大保留字符数（首尾各取一半）
 */
export function truncateLog(text: string, maxChars: number): string {
  if (!text || text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  return `${text.slice(0, half)}\n…[truncated]…\n${text.slice(-half)}`;
}
