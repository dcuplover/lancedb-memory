/**
 * MOD4: Retriever（记忆检索器）
 *
 * 职责：根据查询意图从多层记忆中检索、融合、排序，返回最相关的记忆条目。
 */

import type {
  Retriever,
  RetrieverConfig,
  RetrievalQuery,
  RetrievalResult,
  RetrievedEntry,
  RetrievalLayer,
  IntentAnalysis,
  QueryType,
  ScoredEntry,
  RetrieverStats,
  FusionWeights,
  RerankProvider,
} from "./types";
import type { MemoryStore, EmbeddingProvider, FilterExpression } from "../store/types";
import type { Logger } from "../types/evidence";
import { truncateLog } from "../utils/truncate";

// ─── 工厂函数 ─────────────────────────────────────────────────────────────────

export function createRetriever(
  config: RetrieverConfig,
  store: MemoryStore,
  embeddingProvider: EmbeddingProvider,
  logger?: Logger,
  rerankProvider?: RerankProvider
): Retriever {
  // 统计数据
  const stats = {
    totalQueries: 0,
    totalLatency: 0,
    layerHits: new Map<RetrievalLayer, number>(),
  };

  // ─── 意图分析 ───────────────────────────────────────────────────────────────

  function analyzeIntent(query: RetrievalQuery): IntentAnalysis {
    const text = query.text.toLowerCase();
    const keywordBoosts = new Map<string, number>();

    // 事实类查询 → Knowledge 优先
    if (text.match(/是什么|什么是|what is|怎么|how to|如何/)) {
      return {
        queryType: "factual",
        layerPriority: ["knowledge", "episodic", "stm", "structural"],
        keywordBoosts,
      };
    }

    // 偏好类查询 → Knowledge 优先
    if (text.match(/喜欢|偏好|习惯|prefer|like|favorite|倾向/)) {
      keywordBoosts.set("preference", 1.5);
      return {
        queryType: "preference",
        layerPriority: ["knowledge", "stm", "episodic", "structural"],
        keywordBoosts,
      };
    }

    // 实体类查询 → Structural 优先
    if (text.match(/谁|who|哪个项目|哪个文件|which project|which file|联系方式|contact/)) {
      return {
        queryType: "entity",
        layerPriority: ["structural", "knowledge", "episodic", "stm"],
        keywordBoosts,
      };
    }

    // 过程类查询（历史、上次）→ Episodic 优先
    if (text.match(/上次|之前|历史|last time|previously|before|earlier|过去/)) {
      return {
        queryType: "procedural",
        layerPriority: ["episodic", "knowledge", "stm", "structural"],
        keywordBoosts,
      };
    }

    // 通用查询
    return {
      queryType: "general",
      layerPriority: ["knowledge", "episodic", "stm", "structural"],
      keywordBoosts,
    };
  }

  // ─── 层级检索 ───────────────────────────────────────────────────────────────

  async function searchSTM(query: RetrievalQuery, topK: number): Promise<ScoredEntry[]> {
    if (!query.vector && !query.text) return [];

    try {
      const filter: FilterExpression = {
        and: [
          { gt: ["expiresAt", Date.now()] },
          query.filters?.scope ? { eq: ["sessionKey", query.filters.scope] } : null,
        ].filter(Boolean) as FilterExpression[],
      };
      const effectiveFilter = filter.and!.length > 0 ? filter : undefined;

      // 优先使用混合搜索
      if (query.vector && query.text) {
        const results = await store.hybridSearch("stm", query.text, query.vector, {
          topK,
          minScore: config.minScore * 0.8,
          filter: effectiveFilter,
          vectorWeight: 0.7,
          ftsWeight: 0.3,
        });

        return results.map((r) => {
          const entry = r as any;
          return {
            id: entry.id,
            layer: "stm" as const,
            content: entry.content,
            score: r._score,
            scores: {
              vector: r._vectorScore,
              bm25: r._ftsScore,
              recency: computeRecencyScore(entry.createdAt),
              importance: entry.importance,
            },
            metadata: JSON.parse(entry.metadata),
            timestamp: entry.createdAt,
          };
        });
      }

      // 仅向量
      if (query.vector) {
        const results = await store.vectorSearch("stm", query.vector, {
          topK,
          filter: effectiveFilter,
          minScore: config.minScore * 0.8,
        });

        return results.map((r) => {
          const entry = r as any;
          return {
            id: entry.id,
            layer: "stm" as const,
            content: entry.content,
            score: r._score,
            scores: {
              vector: r._score,
              bm25: 0,
              recency: computeRecencyScore(entry.createdAt),
              importance: entry.importance,
            },
            metadata: JSON.parse(entry.metadata),
            timestamp: entry.createdAt,
          };
        });
      }

      return [];
    } catch (err) {
      logger?.warn("[retriever] STM search failed", { error: err });
      return [];
    }
  }

  async function searchEpisodic(query: RetrievalQuery, topK: number): Promise<ScoredEntry[]> {
    const results: ScoredEntry[] = [];

    try {
      // 优先使用混合搜索
      if (query.vector && query.text) {
        const hybridResults = await store.hybridSearch("episodic", query.text, query.vector, {
          topK,
          minScore: config.minScore * 0.9,
          vectorWeight: 0.6,
          ftsWeight: 0.4,
        });

        results.push(
          ...hybridResults.map((r) => {
            const entry = r as any;
            return {
              id: entry.id,
              layer: "episodic" as const,
              content: entry.content,
              score: r._score,
              scores: {
                vector: r._vectorScore,
                bm25: r._ftsScore,
                recency: computeRecencyScore(entry.timestamp),
                importance: 0.5,
              },
              metadata: JSON.parse(entry.metadata),
              timestamp: entry.timestamp,
            };
          })
        );
      } else if (query.vector) {
        // 仅向量检索
        const vectorResults = await store.vectorSearch("episodic", query.vector, {
          topK,
          minScore: config.minScore * 0.9,
        });

        results.push(
          ...vectorResults.map((r) => {
            const entry = r as any;
            return {
              id: entry.id,
              layer: "episodic" as const,
              content: entry.content,
              score: r._score,
              scores: {
                vector: r._score,
                bm25: 0,
                recency: computeRecencyScore(entry.timestamp),
                importance: 0.5,
              },
              metadata: JSON.parse(entry.metadata),
              timestamp: entry.timestamp,
            };
          })
        );
      }

      // intentKey 精确匹配
      if (query.intentKey) {
        const filter: FilterExpression = {
          and: [
            { eq: ["intentKey", query.intentKey] },
            query.targetKey ? { eq: ["targetKey", query.targetKey] } : null,
          ].filter(Boolean) as FilterExpression[],
        };

        const intentResults = await store.query(
          "episodic",
          filter.and!.length > 0 ? filter : { eq: ["intentKey", query.intentKey] },
          { limit: topK, orderBy: "timestamp", orderDir: "desc" }
        );

        results.push(
          ...intentResults.map((r) => {
            const entry = r as any;
            return {
              id: entry.id,
              layer: "episodic" as const,
              content: entry.content,
              score: 0.95, // 精确匹配高分
              scores: {
                vector: 0,
                bm25: 0.95,
                recency: computeRecencyScore(entry.timestamp),
                importance: 0.5,
              },
              metadata: JSON.parse(entry.metadata),
              timestamp: entry.timestamp,
            };
          })
        );
      }

      // 去重合并
      return mergeUnique(results, topK);
    } catch (err) {
      logger?.warn("[retriever] Episodic search failed", { error: err });
      return [];
    }
  }

  async function searchKnowledge(query: RetrievalQuery, topK: number): Promise<ScoredEntry[]> {
    try {
      const activeFilter: FilterExpression = { eq: ["supersededBy", ""] };

      // 优先使用混合搜索
      if (query.vector && query.text) {
        const hybridResults = await store.hybridSearch("knowledge", query.text, query.vector, {
          topK,
          filter: activeFilter,
          minScore: config.minScore,
          ftsFields: ["claim"],
          vectorWeight: 0.5,
          ftsWeight: 0.5,
        });

        return hybridResults.map((r) => {
          const entry = r as any;
          return {
            id: entry.id,
            layer: "knowledge" as const,
            content: entry.claim,
            score: r._score,
            scores: {
              vector: r._vectorScore,
              bm25: r._ftsScore,
              recency: computeRecencyScore(entry.updatedAt),
              importance: entry.confidence,
            },
            metadata: JSON.parse(entry.metadata),
            timestamp: entry.updatedAt,
          };
        });
      }

      // 仅向量或仅文本搜索的降级路径
      const resultLists: ScoredEntry[][] = [];

      if (query.vector) {
        const vectorResults = await store.vectorSearch("knowledge", query.vector, {
          topK,
          filter: activeFilter,
          minScore: config.minScore,
        });

        resultLists.push(
          vectorResults.map((r) => {
            const entry = r as any;
            return {
              id: entry.id,
              layer: "knowledge" as const,
              content: entry.claim,
              score: r._score,
              scores: {
                vector: r._score,
                bm25: 0,
                recency: computeRecencyScore(entry.updatedAt),
                importance: entry.confidence,
              },
              metadata: JSON.parse(entry.metadata),
              timestamp: entry.updatedAt,
            };
          })
        );
      }

      if (query.text) {
        try {
          const bm25Results = await store.textSearch("knowledge", query.text, {
            topK,
            fields: ["claim"],
            filter: activeFilter,
          });

          resultLists.push(
            bm25Results.map((r) => {
              const entry = r as any;
              return {
                id: entry.id,
                layer: "knowledge" as const,
                content: entry.claim,
                score: r._score,
                scores: {
                  vector: 0,
                  bm25: r._score,
                  recency: computeRecencyScore(entry.updatedAt),
                  importance: entry.confidence,
                },
                metadata: JSON.parse(entry.metadata),
                timestamp: entry.updatedAt,
              };
            })
          );
        } catch {
          // BM25 可能不可用，静默失败
        }
      }

      return fusionRRF(resultLists, 60);
    } catch (err) {
      logger?.warn("[retriever] Knowledge search failed", { error: err });
      return [];
    }
  }

  async function searchStructural(query: RetrievalQuery, topK: number): Promise<ScoredEntry[]> {
    try {
      if (!query.vector && !query.text) return [];

      const entityTopK = Math.ceil(topK / 2);
      let results: ScoredEntry[] = [];

      // 优先使用混合搜索
      if (query.vector && query.text) {
        const hybridResults = await store.hybridSearch("entities", query.text, query.vector, {
          topK: entityTopK,
          minScore: config.minScore * 0.85,
          ftsFields: ["name"],
          vectorWeight: 0.6,
          ftsWeight: 0.4,
        });

        results = hybridResults.map((r) => {
          const entry = r as any;
          return {
            id: entry.id,
            layer: "structural" as const,
            content: `${entry.name} (${entry.entityType})`,
            score: r._score,
            scores: {
              vector: r._vectorScore,
              bm25: r._ftsScore,
              recency: computeRecencyScore(entry.lastSeen),
              importance: Math.min(entry.mentionCount / 100, 1.0),
            },
            metadata: JSON.parse(entry.metadata),
            timestamp: entry.lastSeen,
          };
        });
      } else if (query.vector) {
        // 仅向量检索
        const entityResults = await store.vectorSearch("entities", query.vector, {
          topK: entityTopK,
          minScore: config.minScore * 0.85,
        });

        results = entityResults.map((r) => {
          const entry = r as any;
          return {
            id: entry.id,
            layer: "structural" as const,
            content: `${entry.name} (${entry.entityType})`,
            score: r._score,
            scores: {
              vector: r._score,
              bm25: 0,
              recency: computeRecencyScore(entry.lastSeen),
              importance: Math.min(entry.mentionCount / 100, 1.0),
            },
            metadata: JSON.parse(entry.metadata),
            timestamp: entry.lastSeen,
          };
        });
      }

      // 关系检索（基于已找到的实体）
      if (results.length > 0) {
        const entityIds = results.map((e) => e.id);
        const relationResults = await store.query(
          "relations",
          {
            or: [
              { in: ["fromEntityId", entityIds] },
              { in: ["toEntityId", entityIds] },
            ],
          },
          { limit: Math.ceil(topK / 2), orderBy: "weight", orderDir: "desc" }
        );

        results.push(
          ...relationResults.map((r) => {
            const entry = r as any;
            return {
              id: entry.id,
              layer: "structural" as const,
              content: `Relation: ${entry.relationType}`,
              score: entry.weight,
              scores: {
                vector: 0,
                bm25: 0,
                recency: computeRecencyScore(entry.updatedAt),
                importance: entry.weight,
              },
              metadata: JSON.parse(entry.metadata),
              timestamp: entry.updatedAt,
            };
          })
        );
      }

      return results;
    } catch (err) {
      logger?.warn("[retriever] Structural search failed", { error: err });
      return [];
    }
  }

  // ─── 分数融合 ───────────────────────────────────────────────────────────────

  function fusionRRF(resultLists: ScoredEntry[][], k: number = 60): ScoredEntry[] {
    const scores = new Map<string, number>();
    const entries = new Map<string, ScoredEntry>();

    for (const list of resultLists) {
      list.forEach((entry, rank) => {
        const rrfScore = 1 / (k + rank + 1);
        scores.set(entry.id, (scores.get(entry.id) || 0) + rrfScore);
        entries.set(entry.id, entry);
      });
    }

    return Array.from(entries.values())
      .map((e) => ({ ...e, score: scores.get(e.id)! }))
      .sort((a, b) => b.score - a.score);
  }

  function computeFinalScore(entry: ScoredEntry, weights: FusionWeights, layerWeight: number): number {
    const finalScore =
      weights.vector * entry.scores.vector +
      weights.bm25 * entry.scores.bm25 +
      weights.recency * entry.scores.recency +
      weights.importance * entry.scores.importance;

    return finalScore * layerWeight;
  }

  function computeRecencyScore(timestamp: number): number {
    const age = Date.now() - timestamp;
    return Math.exp(-age / config.recencyHalfLifeMs);
  }

  // ─── 去重与后处理 ───────────────────────────────────────────────────────────

  function mergeUnique(entries: ScoredEntry[], topK: number): ScoredEntry[] {
    const seen = new Set<string>();
    const unique: ScoredEntry[] = [];

    for (const entry of entries) {
      if (!seen.has(entry.id)) {
        seen.add(entry.id);
        unique.push(entry);
      }
    }

    return unique
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  function deduplicateBySimilarity(entries: ScoredEntry[]): ScoredEntry[] {
    const result: ScoredEntry[] = [];

    for (const entry of entries) {
      let isDuplicate = false;
      for (const existing of result) {
        const similarity = computeContentSimilarity(entry.content, existing.content);
        if (similarity > config.dedupeThreshold) {
          isDuplicate = true;
          break;
        }
      }
      if (!isDuplicate) {
        result.push(entry);
      }
    }

    return result;
  }

  function computeContentSimilarity(a: string, b: string): number {
    // 简单的 Jaccard 相似度
    const tokensA = new Set(a.toLowerCase().split(/\s+/));
    const tokensB = new Set(b.toLowerCase().split(/\s+/));
    const intersection = new Set([...tokensA].filter((x) => tokensB.has(x)));
    const union = new Set([...tokensA, ...tokensB]);
    return union.size > 0 ? intersection.size / union.size : 0;
  }

  function postProcess(entries: ScoredEntry[]): RetrievedEntry[] {
    // 1. 去重
    const deduped = deduplicateBySimilarity(entries);

    // 2. 最低分数过滤
    const filtered = deduped.filter((e) => e.score >= config.minScore);

    // 3. 截断
    const truncated = filtered.slice(0, config.topK);

    // 4. 格式化输出
    return truncated.map((e) => ({
      id: e.id,
      layer: e.layer,
      content: truncateLog(e.content, config.maxContentLength),
      score: e.score,
      scores: e.scores,
      metadata: e.metadata,
    }));
  }

  // ─── 主检索方法 ─────────────────────────────────────────────────────────────

  async function retrieve(query: RetrievalQuery): Promise<RetrievalResult> {
    const startTime = Date.now();
    stats.totalQueries++;

    try {
      // 1. 向量化查询（如果未提供）
      if (!query.vector) {
        try {
          query.vector = await embeddingProvider.embed(query.text);
        } catch (err) {
          logger?.warn("[retriever] Embedding failed, fallback to text search only", { error: err });
        }
      }

      // 2. 意图分析
      const intent = analyzeIntent(query);
      logger?.info("[retriever] Intent analysis", { queryType: intent.queryType, layerPriority: intent.layerPriority });

      // 3. 确定要搜索的层
      const layersToSearch = query.layers || intent.layerPriority;
      const topK = query.topK || config.topK;

      // 4. 并行/串行检索各层
      const layerResults = new Map<RetrievalLayer, ScoredEntry[]>();

      if (config.parallelLayers) {
        const promises = layersToSearch.map(async (layer) => {
          const timeoutPromise = new Promise<ScoredEntry[]>((resolve) =>
            setTimeout(() => resolve([]), config.timeoutMs)
          );

          const searchPromise = (async () => {
            switch (layer) {
              case "stm":
                return searchSTM(query, topK);
              case "episodic":
                return searchEpisodic(query, topK);
              case "knowledge":
                return searchKnowledge(query, topK);
              case "structural":
                return searchStructural(query, topK);
              default:
                return [];
            }
          })();

          const result = await Promise.race([searchPromise, timeoutPromise]);
          return { layer, result };
        });

        const results = await Promise.all(promises);
        results.forEach(({ layer, result }) => {
          layerResults.set(layer, result);
          if (result.length > 0) {
            stats.layerHits.set(layer, (stats.layerHits.get(layer) || 0) + 1);
          }
        });
      } else {
        // 串行检索
        for (const layer of layersToSearch) {
          let result: ScoredEntry[] = [];
          switch (layer) {
            case "stm":
              result = await searchSTM(query, topK);
              break;
            case "episodic":
              result = await searchEpisodic(query, topK);
              break;
            case "knowledge":
              result = await searchKnowledge(query, topK);
              break;
            case "structural":
              result = await searchStructural(query, topK);
              break;
          }
          layerResults.set(layer, result);
          if (result.length > 0) {
            stats.layerHits.set(layer, (stats.layerHits.get(layer) || 0) + 1);
          }
        }
      }

      // 5. 融合所有层的结果
      const allEntries: ScoredEntry[] = [];
      layerResults.forEach((entries, layer) => {
        const layerWeight = config.layerWeights[layer];
        entries.forEach((entry) => {
          const finalScore = computeFinalScore(entry, config.fusionWeights, layerWeight);
          allEntries.push({ ...entry, score: finalScore });
        });
      });

      // 6. RRF 跨层融合
      const fusedEntries = allEntries.length > 0 ? fusionRRF([allEntries], 60) : [];

      // 7. Re-rank（可选）
      let rerankedEntries = fusedEntries;
      if (config.rerankEnabled && rerankProvider && fusedEntries.length > 1) {
        try {
          const candidates = fusedEntries.slice(0, config.rerankTopK);
          const documents = candidates.map((e) => e.content);
          const rerankResults = await rerankProvider.rerank(query.text, documents, topK);

          // 按 rerank score 重新排序
          rerankedEntries = rerankResults.map((r) => ({
            ...candidates[r.index],
            score: r.score,
          }));
        } catch (err) {
          logger?.warn("[retriever] Re-rank failed, falling back to fusion order", { error: err });
          // fallback: 继续使用 fusedEntries
        }
      }

      // 8. 后处理
      const finalEntries = postProcess(rerankedEntries);

      // 8. 构建结果
      const queryTimeMs = Date.now() - startTime;
      stats.totalLatency += queryTimeMs;

      const layerBreakdown: Partial<Record<RetrievalLayer, number>> = {};
      layerResults.forEach((entries, layer) => {
        layerBreakdown[layer] = entries.length;
      });

      return {
        entries: finalEntries,
        totalCount: fusedEntries.length,
        queryTimeMs,
        layerBreakdown,
      };
    } catch (err) {
      logger?.error("[retriever] Retrieve failed", { error: err });
      return {
        entries: [],
        totalCount: 0,
        queryTimeMs: Date.now() - startTime,
        layerBreakdown: {},
      };
    }
  }

  // ─── 快捷方法 ───────────────────────────────────────────────────────────────

  async function recallByIntent(
    intentKey: string,
    targetKey?: string,
    topK?: number
  ): Promise<RetrievedEntry[]> {
    const result = await retrieve({
      text: intentKey,
      intentKey,
      targetKey,
      layers: ["episodic"],
      topK: topK || config.topK,
    });
    return result.entries;
  }

  async function recallByEntity(entityName: string, topK?: number): Promise<RetrievedEntry[]> {
    try {
      const vector = await embeddingProvider.embed(entityName);
      const result = await retrieve({
        text: entityName,
        vector,
        layers: ["structural"],
        topK: topK || config.topK,
      });
      return result.entries;
    } catch (err) {
      logger?.warn("[retriever] recallByEntity failed", { error: err });
      return [];
    }
  }

  async function recallRecent(layers: RetrievalLayer[], limit?: number): Promise<RetrievedEntry[]> {
    const entries: ScoredEntry[] = [];

    for (const layer of layers) {
      try {
        const tableName = layer === "structural" ? "entities" : layer;
        const result = await store.query(
          tableName as any,
          {},
          {
            limit: limit || config.topK,
            orderBy: layer === "stm" ? "createdAt" : layer === "knowledge" ? "updatedAt" : "timestamp",
            orderDir: "desc",
          }
        );

        entries.push(
          ...result.map((r) => ({
            id: r.id,
            layer,
            content: (r as any).content || (r as any).claim || "",
            score: 1.0,
            scores: { vector: 0, bm25: 0, recency: 1.0, importance: 0.5 },
            metadata: JSON.parse((r as any).metadata || "{}"),
            timestamp: (r as any).timestamp || (r as any).createdAt || (r as any).updatedAt || Date.now(),
          }))
        );
      } catch (err) {
        logger?.warn(`[retriever] recallRecent failed for layer ${layer}`, { error: err });
      }
    }

    return postProcess(entries);
  }

  function getStats(): RetrieverStats {
    const layerHitRates: Partial<Record<RetrievalLayer, number>> = {};
    stats.layerHits.forEach((hits, layer) => {
      layerHitRates[layer] = stats.totalQueries > 0 ? hits / stats.totalQueries : 0;
    });

    return {
      totalQueries: stats.totalQueries,
      avgLatencyMs: stats.totalQueries > 0 ? stats.totalLatency / stats.totalQueries : 0,
      layerHitRates,
    };
  }

  // ─── 返回接口 ───────────────────────────────────────────────────────────────

  return {
    retrieve,
    recallByIntent,
    recallByEntity,
    recallRecent,
    getStats,
  };
}
