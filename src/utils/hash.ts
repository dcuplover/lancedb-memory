import { createHash } from "crypto";

/**
 * 返回给定字符串 SHA-256 哈希的前 16 位十六进制字符。
 * 用于生成 EvidencePack 的 argsHash / outputHash。
 */
export function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex").slice(0, 16);
}
