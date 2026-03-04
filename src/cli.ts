/**
 * MOD6: CLI 注册（人类运维命令）
 *
 * 注册 6 个 CLI 命令：search, stats, compact, export, import, conflicts
 */

import type { MemoryStore, TableName, AnyEntry } from "./store/types";
import type { Retriever } from "./retrieval/types";
import type { Compactor } from "./lifecycle/types";

// ─── CLI 注册依赖接口 ─────────────────────────────────────────────────────────

export interface CliDependencies {
  store: MemoryStore;
  retriever: Retriever;
  compactor: Compactor;
}

// ─── registerCli 主函数 ───────────────────────────────────────────────────────

/**
 * 注册所有 CLI 命令到 OpenClaw 插件 API。
 *
 * @param api   OpenClaw 插件 API 对象
 * @param deps  依赖项（store, retriever, compactor）
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerCli(api: any, deps: CliDependencies): void {
  const { store, retriever, compactor } = deps;

  api.registerCli(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ({ program }: any) => {
      // ────────────────────────────────────────────────────────────────────────
      // memory search <query> - 语义搜索
      // ────────────────────────────────────────────────────────────────────────
      program
        .command("search")
        .argument("<query>", "查询字符串")
        .option("--limit <n>", "返回结果数量", "10")
        .option("--layers <layers>", "限制检索层（逗号分隔）")
        .description("在记忆中进行语义搜索")
        .action(async (query: string, opts: Record<string, string>) => {
          try {
            const limit = parseInt(opts.limit || "10", 10);
            const layers = opts.layers ? opts.layers.split(",") : undefined;

            const result = await retriever.retrieve({
              text: query,
              topK: limit,
              layers: layers as never,
            });

            if (result.entries.length === 0) {
              console.log("未找到相关记忆");
              return;
            }

            console.log(`找到 ${result.totalCount} 条相关记忆：\n`);
            result.entries.forEach((entry, i) => {
              console.log(
                `[${i + 1}] [${entry.layer}] (score: ${entry.score.toFixed(3)})`
              );
              console.log(`    ${entry.content.slice(0, 100)}${entry.content.length > 100 ? "..." : ""}`);
              console.log();
            });
          } catch (err) {
            console.error("搜索失败:", err);
          }
        });

      // ────────────────────────────────────────────────────────────────────────
      // memory stats - 统计信息
      // ────────────────────────────────────────────────────────────────────────
      program
        .command("stats")
        .description("显示记忆系统统计信息")
        .action(async () => {
          try {
            const tables: TableName[] = ["stm", "episodic", "knowledge", "entities", "relations"];

            console.log("记忆系统统计：\n");
            for (const table of tables) {
              try {
                const stats = await store.getStats(table);
                console.log(`  ${table.padEnd(12)} - 总计: ${stats.rowCount}, 活跃: ${stats.activeCount}, 已删除: ${stats.softDeletedCount}`);
              } catch {
                console.log(`  ${table.padEnd(12)} - 获取失败`);
              }
            }
            console.log();
          } catch (err) {
            console.error("获取统计失败:", err);
          }
        });

      // ────────────────────────────────────────────────────────────────────────
      // memory compact - 手动触发压缩
      // ────────────────────────────────────────────────────────────────────────
      program
        .command("compact")
        .description("手动触发记忆压缩")
        .action(async () => {
          try {
            console.log("开始压缩...");
            const report = await compactor.runFull();

            console.log("\n压缩完成！");
            console.log(`  触发方式: ${report.trigger}`);
            console.log(`  耗时: ${report.durationMs}ms`);

            if (report.results.stmCleanup) {
              console.log(`  STM 清理: 删除 ${report.results.stmCleanup.deleted} 条`);
            }
            if (report.results.stmPromotion) {
              console.log(`  STM 晋升: ${report.results.stmPromotion.promoted} 条 → Episodic`);
            }
            if (report.results.episodicCompression) {
              console.log(
                `  Episodic 压缩: ${report.results.episodicCompression.chainsCompressed} 条链, 删除 ${report.results.episodicCompression.eventsDeleted} 个事件`
              );
            }
            if (report.results.episodicCleanup) {
              console.log(`  Episodic 清理: 删除 ${report.results.episodicCleanup.deleted} 条过期记录`);
            }
            if (report.results.knowledgeMerge) {
              console.log(`  Knowledge 合并: ${report.results.knowledgeMerge.merged} 条相似条目`);
            }
            if (report.results.memoryMdSync) {
              console.log(
                `  MEMORY.md 同步: ${report.results.memoryMdSync.updated ? "已更新" : "未更新"} (${report.results.memoryMdSync.entries} 条, ${report.results.memoryMdSync.tokens} tokens)`
              );
            }

            if (report.errors.length > 0) {
              console.log("\n错误:");
              report.errors.forEach((e) => console.log(`  - ${e.step}: ${e.error}`));
            }
            console.log();
          } catch (err) {
            console.error("压缩失败:", err);
          }
        });

      // ────────────────────────────────────────────────────────────────────────
      // memory export <layer> <path> - 导出为 JSON
      // ────────────────────────────────────────────────────────────────────────
      program
        .command("export")
        .argument("<layer>", "要导出的层（stm/episodic/knowledge/entities/relations）")
        .argument("<path>", "导出文件路径")
        .description("导出指定层的记忆到 JSON 文件")
        .action(async (layer: string, filePath: string) => {
          try {
            if (!["stm", "episodic", "knowledge", "entities", "relations"].includes(layer)) {
              console.error(`无效的层名称: ${layer}`);
              return;
            }

            const entries = await store.query(layer as TableName, {});
            const fs = await import("fs/promises");
            await fs.writeFile(filePath, JSON.stringify(entries, null, 2), "utf-8");

            console.log(`已导出 ${entries.length} 条记录到 ${filePath}`);
          } catch (err) {
            console.error("导出失败:", err);
          }
        });

      // ────────────────────────────────────────────────────────────────────────
      // memory import <layer> <path> - 从 JSON 导入
      // ────────────────────────────────────────────────────────────────────────
      program
        .command("import")
        .argument("<layer>", "要导入的层（stm/episodic/knowledge/entities/relations）")
        .argument("<path>", "导入文件路径")
        .option("--skip-existing", "跳过已存在的记录")
        .description("从 JSON 文件导入记忆到指定层")
        .action(async (layer: string, filePath: string, opts: Record<string, boolean>) => {
          try {
            if (!["stm", "episodic", "knowledge", "entities", "relations"].includes(layer)) {
              console.error(`无效的层名称: ${layer}`);
              return;
            }

            const fs = await import("fs/promises");
            const data = JSON.parse(await fs.readFile(filePath, "utf-8"));

            if (!Array.isArray(data)) {
              console.error("导入文件格式错误: 必须是数组");
              return;
            }

            let imported = 0;
            const skipExisting = opts.skipExisting || false;

            for (const entry of data as AnyEntry[]) {
              try {
                await store.insert(layer as TableName, entry);
                imported++;
              } catch (err) {
                if (skipExisting) {
                  continue;
                } else {
                  console.error(`导入第 ${imported + 1} 条失败:`, err);
                  break;
                }
              }
            }

            console.log(`已导入 ${imported}/${data.length} 条记录到 ${layer}`);
          } catch (err) {
            console.error("导入失败:", err);
          }
        });

      // ────────────────────────────────────────────────────────────────────────
      // memory conflicts - 显示冲突
      // ────────────────────────────────────────────────────────────────────────
      program
        .command("conflicts")
        .description("显示知识层的冲突条目")
        .action(async () => {
          try {
            const conflicts = await compactor.getConflicts();

            if (conflicts.length === 0) {
              console.log("未发现冲突");
              return;
            }

            console.log(`发现 ${conflicts.length} 个冲突：\n`);
            conflicts.forEach((conflict, i) => {
              console.log(`[${i + 1}] 键: ${conflict.key}`);
              conflict.entries.forEach((e) => {
                console.log(`    - ${e.id.slice(0, 8)}: ${e.claim} (confidence: ${e.confidence})`);
              });
              console.log(`    建议保留: ${conflict.suggestedResolution}`);
              console.log();
            });
          } catch (err) {
            console.error("获取冲突失败:", err);
          }
        });
    },
    {
      commands: ["search", "stats", "compact", "export", "import", "conflicts"],
    }
  );
}
