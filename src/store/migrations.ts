/**
 * 迁移机制
 *
 * - 追踪当前 schema 版本（存储在 _schema_migrations 表）
 * - runMigrations() 按版本顺序执行 up() 函数
 * - 同时支持 LanceDB（异步）和 SQLite（同步包装为异步）两种后端
 */

// ─── 类型定义 ─────────────────────────────────────────────────────────────────

/** 迁移描述符 */
export interface Migration {
  version: number;
  description: string;
  up: (ctx: MigrationContext) => Promise<void>;
  down?: (ctx: MigrationContext) => Promise<void>;
}

/** 迁移运行时上下文，传入迁移函数 */
export interface MigrationContext {
  /** LanceDB Connection（仅 LanceDB 模式下可用） */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  lanceDb?: any;
  /** better-sqlite3 Database（仅 SQLite 模式下可用） */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sqliteDb?: any;
}

// ─── 内置迁移列表 ──────────────────────────────────────────────────────────────

/**
 * 项目内置的迁移序列。
 * 新迁移追加到数组末尾，版本号必须严格递增。
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: "初始化 schema（v1）",
    up: async (_ctx) => {
      // v1 = 初始表结构，由 initializeStore 在首次连接时隐式创建
      // 此处仅作版本标记
    },
  },
  // 如需新增迁移，请追加：
  // {
  //   version: 2,
  //   description: "添加 xxx 字段",
  //   up: async (ctx) => { ... },
  //   down: async (ctx) => { ... },
  // },
];

// ─── LanceDB 迁移版本管理 ─────────────────────────────────────────────────────

const LANCE_META_TABLE = "_schema_migrations";

/**
 * 在 LanceDB 中读取当前 schema 版本。
 * 使用一张特殊的元数据表来存版本号（每行是一条迁移记录）。
 */
async function getLanceVersion(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any
): Promise<number> {
  try {
    const table = await db.openTable(LANCE_META_TABLE);
    const rows: Array<Record<string, unknown>> = await table.query().toArray();
    if (!rows || rows.length === 0) return 0;
    const maxVersion = Math.max(...rows.map((r) => Number(r["version"] ?? 0)));
    return maxVersion;
  } catch {
    return 0;
  }
}

/**
 * 在 LanceDB 中记录已执行的迁移版本。
 */
async function recordLanceMigration(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  migration: Migration
): Promise<void> {
  let table;
  try {
    table = await db.openTable(LANCE_META_TABLE);
  } catch {
    table = await db.createTable(LANCE_META_TABLE, [
      { version: 0, description: "__init__", appliedAt: 0 },
    ]);
  }
  await table.add([
    {
      version: migration.version,
      description: migration.description,
      appliedAt: Date.now(),
    },
  ]);
}

// ─── SQLite 迁移版本管理 ──────────────────────────────────────────────────────

const SQLITE_META_TABLE = "_schema_migrations";

/**
 * 在 SQLite DB 中创建迁移记录表（如不存在）并读取当前版本。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function initSqliteMigrationTable(db: any): void {
  db.exec(`CREATE TABLE IF NOT EXISTS ${SQLITE_META_TABLE} (
    version INTEGER PRIMARY KEY,
    description TEXT NOT NULL DEFAULT '',
    appliedAt INTEGER NOT NULL DEFAULT 0
  )`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getSqliteVersion(db: any): number {
  initSqliteMigrationTable(db);
  const row = db
    .prepare(`SELECT MAX(version) as maxV FROM ${SQLITE_META_TABLE}`)
    .get() as { maxV: number | null } | undefined;
  return row?.maxV ?? 0;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function recordSqliteMigration(db: any, migration: Migration): void {
  db.prepare(
    `INSERT OR REPLACE INTO ${SQLITE_META_TABLE} (version, description, appliedAt) VALUES (?, ?, ?)`
  ).run(migration.version, migration.description, Date.now());
}

// ─── 主入口：runMigrations ────────────────────────────────────────────────────

/**
 * 执行所有待运行的迁移（版本 > currentVersion）。
 *
 * @param ctx         迁移上下文（含 lanceDb 或 sqliteDb）
 * @param migrations  迁移列表（默认使用 MIGRATIONS）
 */
export async function runMigrations(
  ctx: MigrationContext,
  migrations: Migration[] = MIGRATIONS
): Promise<void> {
  let currentVersion: number;

  if (ctx.lanceDb) {
    currentVersion = await getLanceVersion(ctx.lanceDb);
  } else if (ctx.sqliteDb) {
    currentVersion = getSqliteVersion(ctx.sqliteDb);
  } else {
    throw new Error("runMigrations: must provide either lanceDb or sqliteDb in context");
  }

  const pending = migrations
    .filter((m) => m.version > currentVersion)
    .sort((a, b) => a.version - b.version);

  for (const migration of pending) {
    await migration.up(ctx);

    if (ctx.lanceDb) {
      await recordLanceMigration(ctx.lanceDb, migration);
    } else if (ctx.sqliteDb) {
      recordSqliteMigration(ctx.sqliteDb, migration);
    }
  }
}

/**
 * 回滚到指定版本（执行 down()，版本 > targetVersion 的迁移按倒序回滚）。
 *
 * @param ctx           迁移上下文
 * @param targetVersion 目标版本（回滚到此版本之后）
 * @param migrations    迁移列表（默认使用 MIGRATIONS）
 */
export async function rollbackMigrations(
  ctx: MigrationContext,
  targetVersion: number,
  migrations: Migration[] = MIGRATIONS
): Promise<void> {
  let currentVersion: number;

  if (ctx.lanceDb) {
    currentVersion = await getLanceVersion(ctx.lanceDb);
  } else if (ctx.sqliteDb) {
    currentVersion = getSqliteVersion(ctx.sqliteDb);
  } else {
    throw new Error("rollbackMigrations: must provide either lanceDb or sqliteDb in context");
  }

  const toRollback = migrations
    .filter((m) => m.version > targetVersion && m.version <= currentVersion && m.down)
    .sort((a, b) => b.version - a.version);

  for (const migration of toRollback) {
    await migration.down!(ctx);
  }
}
