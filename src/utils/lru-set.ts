/**
 * 固定容量的 LRU Set，带时间戳支持。
 *
 * - 容量满时自动淘汰最早插入的条目（LRU eviction）
 * - has(key, windowMs) 支持时间窗口过期检查：超过 windowMs 毫秒的条目视为不存在
 * - 用于 EventCollector 的去重窗口机制（默认 5 分钟内同事件去重）
 */
export class LRUSet<T> {
  /** key → 最近插入/刷新的时间戳 */
  private readonly map = new Map<T, number>();

  constructor(private readonly maxSize: number) {}

  /**
   * 检查 key 是否存在。
   * @param key       待查找的键
   * @param windowMs  可选时间窗口（毫秒）。若存在但超过 windowMs，视为不存在并从集合中删除。
   */
  has(key: T, windowMs?: number): boolean {
    const ts = this.map.get(key);
    if (ts === undefined) return false;
    if (windowMs !== undefined && Date.now() - ts > windowMs) {
      this.map.delete(key);
      return false;
    }
    return true;
  }

  /**
   * 添加（或刷新）一个 key。
   * 若已存在则刷新时间戳；若容量已满则先淘汰最老的条目再插入。
   */
  add(key: T): void {
    if (this.map.has(key)) {
      // 刷新时间戳：删除后重新插入（Map 保持插入顺序）
      this.map.delete(key);
    } else if (this.map.size >= this.maxSize) {
      // 淘汰最早插入的条目
      const oldest = this.map.keys().next().value as T;
      this.map.delete(oldest);
    }
    this.map.set(key, Date.now());
  }

  get size(): number {
    return this.map.size;
  }
}
