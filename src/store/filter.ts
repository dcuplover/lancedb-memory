import type { FilterExpression } from "./types";

/**
 * 将 FilterExpression 转换为 LanceDB / SQLite 兼容的 SQL WHERE 子句字符串。
 *
 * 支持运算符：
 *   and, or, eq, ne, gt, lt, gte, lte, in, isNull, isNotNull
 *
 * 安全措施：
 *   - 列名只允许 [a-zA-Z0-9_] 字符，防止 SQL 注入
 *   - 字符串值通过 escapeSqlString 单引号转义
 *   - 数值直接转为字符串（无引号）
 *
 * @throws {Error} 遇到未知运算符或列名非法时抛出
 */
export function buildWhereClause(expr: FilterExpression): string {
  // and
  if (expr.and !== undefined) {
    if (expr.and.length === 0) return "1=1";
    const parts = expr.and.map(buildWhereClause);
    return `(${parts.join(" AND ")})`;
  }

  // or
  if (expr.or !== undefined) {
    if (expr.or.length === 0) return "1=0";
    const parts = expr.or.map(buildWhereClause);
    return `(${parts.join(" OR ")})`;
  }

  // eq
  if (expr.eq !== undefined) {
    const [col, val] = expr.eq;
    return `${safeCol(col)} = ${sqlLiteral(val)}`;
  }

  // ne
  if (expr.ne !== undefined) {
    const [col, val] = expr.ne;
    return `${safeCol(col)} != ${sqlLiteral(val)}`;
  }

  // gt
  if (expr.gt !== undefined) {
    const [col, val] = expr.gt;
    return `${safeCol(col)} > ${val}`;
  }

  // lt
  if (expr.lt !== undefined) {
    const [col, val] = expr.lt;
    return `${safeCol(col)} < ${val}`;
  }

  // gte
  if (expr.gte !== undefined) {
    const [col, val] = expr.gte;
    return `${safeCol(col)} >= ${val}`;
  }

  // lte
  if (expr.lte !== undefined) {
    const [col, val] = expr.lte;
    return `${safeCol(col)} <= ${val}`;
  }

  // in
  if (expr.in !== undefined) {
    const [col, vals] = expr.in;
    if (vals.length === 0) return "1=0";
    const list = vals.map(sqlLiteral).join(", ");
    return `${safeCol(col)} IN (${list})`;
  }

  // isNull
  if (expr.isNull !== undefined) {
    return `${safeCol(expr.isNull)} IS NULL`;
  }

  // isNotNull
  if (expr.isNotNull !== undefined) {
    return `${safeCol(expr.isNotNull)} IS NOT NULL`;
  }

  // 空表达式 → 全匹配
  return "1=1";
}

/**
 * 验证并返回安全的列名；列名只允许字母/数字/下划线。
 */
function safeCol(col: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(col)) {
    throw new Error(`Unsafe column name in filter: "${col}"`);
  }
  return col;
}

/**
 * 将 JavaScript 值转换为 SQL 字面量。
 * - string → 单引号，内部单引号用 '' 转义
 * - number/boolean → 直接 toString
 * - null → NULL
 * - 其他 → JSON 字符串（单引号包裹）
 */
export function sqlLiteral(val: unknown): string {
  if (val === null || val === undefined) return "NULL";
  if (typeof val === "number") return String(val);
  if (typeof val === "boolean") return val ? "1" : "0";
  if (typeof val === "string") return `'${escapeSqlString(val)}'`;
  // 对象/数组退化为 JSON 字符串
  return `'${escapeSqlString(JSON.stringify(val))}'`;
}

/**
 * 将字符串中的单引号转义为两个单引号（SQL 标准转义）。
 */
function escapeSqlString(s: string): string {
  return s.replace(/'/g, "''");
}

/**
 * 构建 sort 子句（不含 ORDER BY 关键字）
 */
export function buildOrderClause(orderBy: string, orderDir: "asc" | "desc"): string {
  return `${safeCol(orderBy)} ${orderDir.toUpperCase()}`;
}
