/**
 * 基于配置的 OpenAI 兼容 Embedding 客户端
 *
 * 使用 embedding.baseURL / apiKey / model / dimensions 直接调用 API，
 * 不依赖框架的 api.services.embedding。
 */

import type { EmbeddingProvider } from "../store/types";

export interface EmbeddingClientConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  dimensions: number;
}

/**
 * 创建基于 HTTP 的 EmbeddingProvider。
 * 兼容 OpenAI /v1/embeddings 接口 (及兼容端点)。
 */
export function createEmbeddingProvider(cfg: EmbeddingClientConfig): EmbeddingProvider {
  const url = cfg.baseURL.replace(/\/+$/, "") + "/embeddings";

  async function callApi(input: string | string[]): Promise<number[][]> {
    const body: Record<string, unknown> = {
      model: cfg.model,
      input,
    };
    // dimensions 参数让 API 服务端截断/调整维度
    if (cfg.dimensions) {
      body.dimensions = cfg.dimensions;
    }

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(
        `Embedding API request failed [${resp.status}]: ${text}`
      );
    }

    const json = (await resp.json()) as {
      data: Array<{ embedding: number[] }>;
    };
    return json.data.map((d) => d.embedding);
  }

  return {
    async embed(text: string): Promise<Float32Array> {
      const [vec] = await callApi(text);
      return new Float32Array(vec);
    },

    async embedBatch(texts: string[]): Promise<Float32Array[]> {
      if (texts.length === 0) return [];
      const vecs = await callApi(texts);
      return vecs.map((v) => new Float32Array(v));
    },

    dimension: cfg.dimensions,
  };
}
