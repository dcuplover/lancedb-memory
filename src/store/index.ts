/**
 * src/store/index.ts
 *
 * 工厂函数 initializeStore()：
 *  1. 动态导入 LanceDB
 *  2. 尝试连接，失败时指数退避重试（最多 3 次）
 *  3. 三次失败后自动降级到 SQLite
 *  4. 运行迁移（runMigrations）
 *  5. 返回 MemoryStore 实例
 */

import * as path from "path";
import * as os from "os";
import { LanceDBStore } from "./lance-store";
import { SQLiteStore } from "./sqlite-store";
import { runMigrations, MIGRATIONS } from "./migrations";
import { getSampleRow, TABLE_NAMES } from "./schema";
import { DEFAULT_STORE_CONFIG } from "./types";
import type { MemoryStore, StoreConfig } from "./types";

export * from "./types";
export * from "./filter";
export * from "./schema";
export * from "./migrations";
export { LanceDBStore } from "./lance-store";
export { SQLiteStore } from "./sqlite-store";
export { DimensionMismatchError } from "./lance-store";
export { VectorSearchNotSupportedError } from "./sqlite-store";

// ─── 等待辅助 ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── LanceDB 初始化 ───────────────────────────────────────────────────────────

async function tryInitLance(
  dbPath: string,
  config: StoreConfig,
  logger?: Logger
): Promise<LanceDBStore> {
  const lancedb = await import("@lancedb/lancedb");
  const db = await lancedb.connect(dbPath);

  // 确保所有表存在
  for (const tableName of TABLE_NAMES) {
    try {
      await db.openTable(tableName);
    } catch {
      const sample = getSampleRow(tableName, config.vectorDimension);
      await db.createTable(tableName, [sample]);
    }
  }

  // 运行迁移
  await runMigrations({ lanceDb: db }, MIGRATIONS);

  logger?.info?.(`[store] LanceDB 连接成功：${dbPath}`);
  return new LanceDBStore(db, config);
}

// ─── Logger 类型 ──────────────────────────────────────────────────────────────

export interface Logger {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (msg: string, err?: unknown) => void;
}

// ─── initializeStore ─────────────────────────────────────────────────────────

/**
 * 初始化 MemoryStore。
 *
 * @param partialConfig  部分配置（未提供字段使用默认值）
 * @param logger         可选日志接口
 * @returns              MemoryStore 实例（LanceDB 或 SQLite 降级）
 */
export async function initializeStore(
  partialConfig: Partial<StoreConfig> & { dbPath: string },
  logger?: Logger
): Promise<MemoryStore> {
  const config: StoreConfig = {
    ...DEFAULT_STORE_CONFIG,
    ...partialConfig,
    tables: {
      ...DEFAULT_STORE_CONFIG.tables,
      ...(partialConfig.tables ?? {}),
    },
  };

  const dbPath = config.dbPath || path.join(os.homedir(), ".openclaw", "memory", "default");

  // ── 重试逻辑（1s / 2s / 4s） ─────────────────────────────────────────────
  const retryDelays = [1000, 2000, 4000];
  let lastError: unknown;

  for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
    try {
      return await tryInitLance(dbPath, config, logger);
    } catch (err) {
      lastError = err;
      if (attempt < retryDelays.length) {
        const delay = retryDelays[attempt];
        logger?.warn?.(`[store] LanceDB 连接失败（第 ${attempt + 1} 次），${delay}ms 后重试：${String(err)}`);
        await sleep(delay);
      }
    }
  }

  // ── 降级到 SQLite ─────────────────────────────────────────────────────────
  logger?.warn?.(`[store] LanceDB 三次重试均失败，降级到 SQLite。最后错误：${String(lastError)}`);

  const sqlitePath = dbPath.endsWith(".db") ? dbPath : `${dbPath}.sqlite`;
  const sqliteStore = new SQLiteStore(sqlitePath);

  // SQLite 也运行迁移（获取内部 db 实例稍显 hack，通过特殊方法暴露）
  try {
    // SQLiteStore 构造函数已在内部初始化表，此处仅记录迁移版本
    await runMigrations({ sqliteDb: (sqliteStore as unknown as { db: unknown }).db }, MIGRATIONS);
  } catch (err) {
    logger?.warn?.(`[store] SQLite 迁移执行失败（非致命）：${String(err)}`);
  }

  logger?.info?.(`[store] SQLite 降级存储已初始化：${sqlitePath}`);
  return sqliteStore;
}
