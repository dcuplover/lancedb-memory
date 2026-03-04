/**
 * 递归替换对象中的敏感字段值为 "[REDACTED]"。
 * 字段名匹配不区分大小写（apiKey、APIKEY、api_key 均匹配 "apiKey"）。
 *
 * @param obj    待脱敏的对象（浅拷贝，不修改原对象）
 * @param keys   需要脱敏的字段名列表，默认 ["apiKey","token","password","secret"]
 */
export function redactSensitive(
  obj: Record<string, unknown>,
  keys: string[],
): Record<string, unknown> {
  const lowerKeys = keys.map((k) => k.toLowerCase());
  const result: Record<string, unknown> = {};

  for (const [k, v] of Object.entries(obj)) {
    if (lowerKeys.includes(k.toLowerCase())) {
      result[k] = "[REDACTED]";
    } else if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      result[k] = redactSensitive(v as Record<string, unknown>, keys);
    } else {
      result[k] = v;
    }
  }

  return result;
}
