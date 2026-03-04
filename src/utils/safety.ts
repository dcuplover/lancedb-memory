/**
 * 安全模式工具函数
 *
 * 提供超时、重试、限流等质量保障机制，遵循 SKILL.md Hard Constraints。
 */

// ─── 超时包装器 ───────────────────────────────────────────────────────────────

/**
 * 包装异步函数，超时后返回降级值而非抛出异常。
 *
 * @param fn          异步函数
 * @param timeoutMs   超时时长（毫秒）
 * @param fallback    超时降级返回值
 * @returns           正常结果或降级值
 */
export async function withTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  fallback: T
): Promise<T> {
  return Promise.race([
    fn(),
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs)
    ),
  ]).catch(() => fallback);
}

// ─── 重试 + 指数退避 ──────────────────────────────────────────────────────────

/**
 * 包装异步函数，失败时按指数退避策略重试（最多 maxRetries 次）。
 *
 * @param fn              异步函数
 * @param maxRetries      最大重试次数（默认 3）
 * @param initialDelayMs  初始延迟（默认 500ms）
 * @returns               成功结果
 * @throws                所有重试耗尽后抛出最后一次错误
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  initialDelayMs: number = 500
): Promise<T> {
  let lastError: Error;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err as Error;
      // 仅对可恢复错误重试（网络超时、限流等）
      if (!isRetryable(err) || attempt === maxRetries) {
        throw lastError;
      }
      const delay = initialDelayMs * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError!;
}

/**
 * 判断错误是否可重试（网络超时、限流等）。
 */
function isRetryable(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return (
      msg.includes("timeout") ||
      msg.includes("econnreset") ||
      msg.includes("enotfound") ||
      msg.includes("429") ||
      msg.includes("503") ||
      msg.includes("rate limit")
    );
  }
  return false;
}

// ─── 滑动窗口限流器 ───────────────────────────────────────────────────────────

/**
 * 滑动窗口限流器，防止短时间内过多写入请求。
 *
 * @example
 * const limiter = new SlidingWindowLimiter(20, 5 * 60 * 1000); // 5分钟内最多 20 次
 * if (!limiter.canProceed()) {
 *   return { success: false, reason: "rate_limited" };
 * }
 */
export class SlidingWindowLimiter {
  private timestamps: number[] = [];

  constructor(
    private maxCount: number,
    private windowMs: number
  ) {}

  /**
   * 检查当前是否可以执行操作。
   *
   * @returns true 表示可以执行，false 表示已超限
   */
  canProceed(): boolean {
    const now = Date.now();
    // 移除窗口外的时间戳
    this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs);
    if (this.timestamps.length >= this.maxCount) {
      return false;
    }
    this.timestamps.push(now);
    return true;
  }

  /**
   * 重置限流器状态。
   */
  reset(): void {
    this.timestamps = [];
  }

  /**
   * 获取当前窗口内的请求数。
   */
  getCurrentCount(): number {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs);
    return this.timestamps.length;
  }
}

// ─── 输入校验 ─────────────────────────────────────────────────────────────────

/**
 * 输入边界校验辅助函数。
 */
export function validateInput(params: {
  content?: string;
  query?: string;
  scope?: string;
}): void {
  const MAX_CONTENT_LENGTH = 10000;
  const MAX_QUERY_LENGTH = 2000;
  const SCOPE_PATTERN = /^[a-zA-Z0-9_:.-]+$/;

  if (params.content && params.content.length > MAX_CONTENT_LENGTH) {
    throw new Error(`Content exceeds max length (${MAX_CONTENT_LENGTH} chars)`);
  }
  if (params.query && params.query.length > MAX_QUERY_LENGTH) {
    throw new Error(`Query exceeds max length (${MAX_QUERY_LENGTH} chars)`);
  }
  if (params.scope && !SCOPE_PATTERN.test(params.scope)) {
    throw new Error(`Invalid scope format: ${params.scope}`);
  }
}
