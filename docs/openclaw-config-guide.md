# OpenClaw memory-4layer 插件配置指南

本文档介绍如何在 OpenClaw 的 `openclaw.json` 配置文件中正确配置 **memory-4layer** 插件。

---

## 目录

1. [整体结构层级](#1-整体结构层级)
2. [五个常见错误及修复方法](#2-五个常见错误及修复方法)
3. [框架级字段说明（entries 层级）](#3-框架级字段说明entries-层级)
4. [plugins.slots 说明](#4-pluginsslots-说明)
5. [配置校验技巧](#5-配置校验技巧)
6. [最简可用配置](#6-最简可用配置)
7. [完整插件配置参数参考](#7-完整插件配置参数参考)
8. [快速查阅表](#8-快速查阅表)

---

## 1. 整体结构层级

`openclaw.json` 中插件相关配置的正确层级如下：

```jsonc
{
  "plugins": {
    // ① 插槽（slot）声明：指定各功能槽位使用哪个插件
    "slots": {
      "memory": "memory-4layer"
    },

    // ② 插件条目：每个插件的启用状态与具体配置
    "entries": {
      "memory-4layer": {
        "enabled": true,           // 框架级：是否加载此插件
        "path": "",                // 框架级：可选，自定义插件路径
        "config": {                // ← 所有插件特有参数必须放在这里
          "embedding": {
            "apiKey": "sk-..."
          },
          "dbPath": "~/.openclaw/memory-db"
          // ... 其他插件参数
        }
      }
    }
  }
}
```

> **关键点**
>
> - `slots` 和 `entries` 是 `plugins` 下的**同级**字段。
> - `entries.<plugin-id>` 层级**只接受** `enabled`、`config`、`path` 三个键。
> - `embedding`、`dbPath`、`collector`、`router`、`store`、`retriever`、`rerank`、`compactor`
>   等所有插件特有参数，必须写在 `config` 对象内部。

---

## 2. 五个常见错误及修复方法

### 错误 1：插件参数写在 entries 层级而非 config 内部

**错误信息**
```
plugins.entries.memory-4layer: Unrecognized key: "embedding"
```

**错误示例**
```jsonc
// ❌ 错误：embedding 直接写在 entries.memory-4layer 下
"entries": {
  "memory-4layer": {
    "enabled": true,
    "embedding": {        // ← 不应在此处
      "apiKey": "sk-..."
    }
  }
}
```

**正确示例**
```jsonc
// ✅ 正确：embedding 写在 config 内部
"entries": {
  "memory-4layer": {
    "enabled": true,
    "config": {           // ← 所有插件参数放入 config
      "embedding": {
        "apiKey": "sk-..."
      }
    }
  }
}
```

---

### 错误 2：slots 放在错误的层级（根级而非 plugins 下）

**错误信息**
```
<root>: Unrecognized key: "slots"
```

**错误示例**
```jsonc
// ❌ 错误：slots 放在了根级
{
  "slots": {              // ← 不应在根级
    "memory": "memory-4layer"
  },
  "plugins": {
    "entries": { ... }
  }
}
```

**正确示例**
```jsonc
// ✅ 正确：slots 必须在 plugins 下
{
  "plugins": {
    "slots": {            // ← 位于 plugins 内部
      "memory": "memory-4layer"
    },
    "entries": { ... }
  }
}
```

---

### 错误 3：slots.memory 指向了另一个插件

**错误信息**
```
plugin disabled (memory slot set to "memory-core") but config is present
```

**原因说明**

`plugins.slots.memory` 同时只能有一个活跃插件。如果将该槽位设置为其他插件（如 `"memory-core"`），则 memory-4layer 即使写了 `config` 也不会生效。

**修复方法**
```jsonc
// 将 memory 槽位改为当前插件
"slots": {
  "memory": "memory-4layer"   // ← 确保与 entries 中的插件 id 一致
}

// 或者，若暂时不需要记忆功能，可关闭槽位：
"slots": {
  "memory": "none"
}
```

---

### 错误 4：旧插件目录残留导致安装失败

**错误信息**
```
plugin already exists: ~/.openclaw/extensions/memory-4layer (delete it first)
```

**修复方法**
```bash
# 先删除旧目录
rm -rf ~/.openclaw/extensions/memory-4layer

# 然后重新安装
openclaw plugin install memory-4layer
```

---

### 错误 5：缺少必填字段 embedding.apiKey

**错误信息**
```
[memory-4layer] FATAL: embedding.apiKey is required in plugin config
```

**修复方法**

在 `config.embedding` 中填写有效的 API Key：

```jsonc
"config": {
  "embedding": {
    "apiKey": "sk-xxxxxxxxxxxxxxxx"   // ← 必填，不可为空
  }
}
```

---

## 3. 框架级字段说明（entries 层级）

这三个字段由 OpenClaw 框架本身处理，不属于插件业务逻辑。

| 字段      | 类型    | 必填 | 说明                                               |
| --------- | ------- | ---- | -------------------------------------------------- |
| `enabled` | boolean | 否   | 是否加载此插件，默认 `true`                        |
| `config`  | object  | 否   | 传递给插件的配置对象，内容由插件自身的 schema 定义 |
| `path`    | string  | 否   | 覆盖插件加载路径，留空则使用默认安装路径           |

---

## 4. plugins.slots 说明

`plugins.slots` 定义了各功能槽位（slot）与具体插件的绑定关系。

```jsonc
"slots": {
  "memory": "memory-4layer"   // 将 memory 槽位绑定到 memory-4layer
}
```

- **memory 槽位** 同时只能有一个活跃插件。如果安装了多个记忆类插件，需在此处指定使用哪一个。
- 设置为 `"none"` 可禁用该槽位：

  ```jsonc
  "slots": {
    "memory": "none"
  }
  ```

---

## 5. 配置校验技巧

在修改 `openclaw.json` 后，可以使用以下命令验证配置是否正确：

```bash
# 检查配置文件语法与 schema 合规性
openclaw config validate

# 自动诊断并尝试修复常见配置问题
openclaw doctor --fix
```

---

## 6. 最简可用配置

以下是仅需填写**必填项**的最简配置，其余参数均使用默认值：

```jsonc
{
  "plugins": {
    "slots": {
      "memory": "memory-4layer"
    },
    "entries": {
      "memory-4layer": {
        "enabled": true,
        "config": {
          "embedding": {
            "apiKey": "sk-xxxxxxxxxxxxxxxx"   // 唯一必填项
          }
        }
      }
    }
  }
}
```

---

## 7. 完整插件配置参数参考

所有参数均放在 `plugins.entries.memory-4layer.config` 内。

### 7.1 顶层参数

| 参数名            | 类型    | 默认值                    | 说明                                 |
| ----------------- | ------- | ------------------------- | ------------------------------------ |
| `enabled`         | boolean | `true`                    | 插件业务层开关，写在 `config` 内；框架层的 `enabled`（见第 3 节）写在 `entries.<id>` 下，两者相互独立 |
| `autoCapture`     | boolean | `true`                    | 是否自动采集 Hook 事件到记忆系统     |
| `autoRecall`      | boolean | `true`                    | 是否在 Agent 启动前自动注入相关记忆  |
| `dbPath`          | string  | `~/.openclaw/memory-db`   | LanceDB 本地存储路径，支持 `~` 扩展  |
| `vectorDimension` | number  | `1536`                    | 向量维度，应与嵌入模型输出维度一致   |

### 7.2 embedding（嵌入配置）

| 参数名       | 类型   | 默认值                       | 说明                             |
| ------------ | ------ | ---------------------------- | -------------------------------- |
| `apiKey`     | string | —                            | **必填**，OpenAI 兼容的 API Key  |
| `model`      | string | `text-embedding-3-small`     | 向量嵌入模型名称                 |
| `baseURL`    | string | `https://api.openai.com/v1`  | 自定义 API 端点，兼容国产模型    |
| `dimensions` | number | `1536`                       | 嵌入输出维度（覆盖 vectorDimension） |

### 7.3 collector（采集器配置）

| 参数名                        | 类型     | 默认值                                               | 说明                                     |
| ----------------------------- | -------- | ---------------------------------------------------- | ---------------------------------------- |
| `enabled`                     | boolean  | `true`                                               | 是否启用采集器                           |
| `maxLogChars`                 | number   | `800`                                                | 工具调用日志截断长度（字符数）           |
| `dedupeWindowMs`              | number   | `300000`（5 分钟）                                   | 事件去重时间窗口（毫秒）                 |
| `minMessageLength`            | number   | `5`                                                  | 英文消息最小长度（低于此值不采集）       |
| `minMessageLengthCJK`         | number   | `3`                                                  | 中日韩消息最小长度                       |
| `maxEvidencePerAgentEnd`      | number   | `10`                                                 | 每次 AgentEnd 事件最多采集的证据条数     |
| `compactionSnapshotMessages`  | number   | `20`                                                 | 触发快照压缩的消息数量阈值               |
| `excludeTools`                | string[] | `["memory_recall","memory_store","memory_forget"]`   | 不采集日志的工具名列表                   |
| `redactKeys`                  | string[] | `["apiKey","token","password","secret"]`             | 需要脱敏的字段名列表                     |

### 7.4 router（路由器配置）

| 参数名                       | 类型   | 默认值           | 说明                                                              |
| ---------------------------- | ------ | ---------------- | ----------------------------------------------------------------- |
| `classifyMode`               | string | `rules_then_llm` | 分类模式：`rules_only` / `rules_then_llm` / `llm_only`           |
| `llmModel`                   | string | `haiku`          | 用于 LLM 分类的模型（当 classifyMode 包含 llm 时生效）           |
| `llmMaxTokens`               | number | `200`            | LLM 分类的最大token数                                            |
| `stmTTLMs`                   | number | `3600000`（1 h） | 短时记忆（STM）存活时间（毫秒）                                   |
| `minConfidenceForKnowledge`  | number | `0.7`            | 路由到知识层的最低置信度（0–1）                                   |
| `minConfidenceForStructural` | number | `0.8`            | 路由到结构层的最低置信度（0–1）                                   |
| `batchSize`                  | number | `5`              | 批量写入大小                                                      |
| `batchDelayMs`               | number | `100`            | 批量写入延迟（毫秒）                                              |

### 7.5 store（存储层配置）

| 参数名                       | 类型    | 默认值          | 说明                                              |
| ---------------------------- | ------- | --------------- | ------------------------------------------------- |
| `tables.stm.maxEntries`      | number  | `500`           | STM 表最大条目数                                  |
| `tables.episodic.maxEntries` | number  | `10000`         | 情节记忆表最大条目数                              |
| `tables.knowledge.maxEntries`| number  | `2000`          | 知识层表最大条目数                                |
| `tables.entities.maxEntries` | number  | `1000`          | 实体表最大条目数                                  |
| `tables.relations.maxEntries`| number  | `5000`          | 关系表最大条目数                                  |
| `vectorIndexType`            | string  | `IVF_PQ`        | 向量索引类型：`IVF_PQ` / `HNSW`                  |
| `ftsEnabled`                 | boolean | `true`          | 是否启用全文搜索（FTS）                           |
| `ftsLanguage`                | string  | `auto`          | FTS 语言：`english` / `chinese` / `auto`         |
| `batchSize`                  | number  | `100`           | 存储批量大小                                      |
| `vacuumIntervalMs`           | number  | `86400000`（1 d）| 数据库清理间隔（毫秒）                           |

### 7.6 retriever（检索器配置）

| 参数名              | 类型    | 默认值                                    | 说明                                                  |
| ------------------- | ------- | ----------------------------------------- | ----------------------------------------------------- |
| `topK`              | number  | `10`                                      | 默认返回的记忆条目数                                  |
| `minScore`          | number  | `0.3`                                     | 最低相似度阈值（0–1），低于此值的结果被过滤            |
| `maxContentLength`  | number  | `500`                                     | 单条记忆内容最大字符数（超出截断）                    |
| `layerWeights.stm`          | number | `0.8`                            | STM 层检索权重                                        |
| `layerWeights.episodic`     | number | `1.0`                            | 情节层检索权重                                        |
| `layerWeights.knowledge`    | number | `1.2`                            | 知识层检索权重                                        |
| `layerWeights.structural`   | number | `1.1`                            | 结构层检索权重                                        |
| `fusionWeights.vector`      | number | `0.4`                            | 向量搜索融合权重                                      |
| `fusionWeights.bm25`        | number | `0.2`                            | BM25 全文搜索融合权重                                 |
| `fusionWeights.recency`     | number | `0.2`                            | 时效性融合权重                                        |
| `fusionWeights.importance`  | number | `0.2`                            | 重要性融合权重                                        |
| `rerankEnabled`     | boolean | `false`                                   | 是否启用 Re-ranker（需配合 `rerank` 配置块）          |
| `rerankModel`       | string  | `cross-encoder/ms-marco-MiniLM-L-6-v2`   | Re-ranker 模型名称                                    |
| `rerankTopK`        | number  | `20`                                      | 送入 Re-ranker 的候选数量                             |
| `rerankBaseURL`     | string  | `""`                                      | Re-ranker 服务端点（自定义部署时填写）                |
| `parallelLayers`    | boolean | `true`                                    | 是否并行检索各记忆层                                  |
| `timeoutMs`         | number  | `5000`                                    | 检索超时时间（毫秒）                                  |
| `dedupeThreshold`   | number  | `0.9`                                     | 检索结果去重相似度阈值（0–1）                         |
| `recencyHalfLifeMs` | number  | `86400000`（1 d）                         | 时效性衰减半衰期（毫秒）                              |

### 7.7 rerank（Re-ranker 配置）

启用 Re-ranker 时需同时在 `retriever` 中设置 `rerankEnabled: true`。

| 参数名     | 类型   | 默认值                                  | 说明                                    |
| ---------- | ------ | --------------------------------------- | --------------------------------------- |
| `apiKey`   | string | —                                       | Re-ranker 服务的 API Key（Cohere/Jina 等） |
| `baseURL`  | string | `""`                                    | Re-ranker 服务端点（可选）              |
| `model`    | string | `cross-encoder/ms-marco-MiniLM-L-6-v2` | Re-ranker 模型名称                      |

### 7.8 compactor（压缩器配置）

#### compactor.compaction

| 参数名                   | 类型    | 默认值            | 说明                         |
| ------------------------ | ------- | ----------------- | ---------------------------- |
| `intervalMs`             | number  | `3600000`（1 h）  | 定时压缩任务触发间隔（毫秒） |
| `enableHookTrigger`      | boolean | `true`            | 是否允许 Hook 事件触发压缩   |
| `enableThresholdTrigger` | boolean | `true`            | 是否允许阈值超限触发压缩     |

#### compactor.stm

| 参数名             | 类型   | 默认值            | 说明                              |
| ------------------ | ------ | ----------------- | --------------------------------- |
| `maxEntries`       | number | `500`             | STM 最大条目数                    |
| `promoteThreshold` | number | `0.7`             | 提升到情节层的重要性阈值（0–1）   |
| `promoteWindowMs`  | number | `300000`（5 min） | 用于计算提升资格的时间窗口（毫秒）|

#### compactor.episodic

| 参数名                        | 类型   | 默认值              | 说明                           |
| ----------------------------- | ------ | ------------------- | ------------------------------ |
| `maxEntries`                  | number | `10000`             | 情节记忆最大条目数             |
| `retentionMs`                 | number | `2592000000`（30 d）| 情节记忆保留时间（毫秒）       |
| `chainAgeThresholdMs`         | number | `86400000`（1 d）   | 链式记忆压缩年龄阈值（毫秒）   |
| `minChainLengthForCompression`| number | `3`                 | 触发链式压缩的最小链长度       |

#### compactor.knowledge

| 参数名                    | 类型   | 默认值 | 说明                               |
| ------------------------- | ------ | ------ | ---------------------------------- |
| `maxEntries`              | number | `2000` | 知识层最大条目数                   |
| `mergeSimilarityThreshold`| number | `0.92` | 合并相似知识条目的相似度阈值（0–1）|

#### compactor.memoryMd

| 参数名       | 类型    | 默认值        | 说明                                     |
| ------------ | ------- | ------------- | ---------------------------------------- |
| `enabled`    | boolean | `true`        | 是否生成 MEMORY.md 快照文件              |
| `maxEntries` | number  | `150`         | MEMORY.md 中最多包含的记忆条目数         |
| `maxTokens`  | number  | `10000`       | MEMORY.md 最大token数                    |
| `path`       | string  | `MEMORY.md`   | MEMORY.md 文件路径（相对于工作目录）     |

---

## 8. 快速查阅表

| 你想配置的内容                      | 对应的配置路径                                                   |
| ----------------------------------- | ---------------------------------------------------------------- |
| 嵌入模型 API Key                    | `config.embedding.apiKey`                                        |
| 使用国产/自定义嵌入 API             | `config.embedding.baseURL`                                       |
| 数据库存储位置                      | `config.dbPath`                                                  |
| 关闭自动记忆采集                    | `config.autoCapture: false`                                      |
| 关闭自动记忆召回                    | `config.autoRecall: false`                                       |
| 检索返回条数                        | `config.retriever.topK`                                          |
| 最低相似度过滤阈值                  | `config.retriever.minScore`                                      |
| 启用 Re-ranker                      | `config.retriever.rerankEnabled: true` + `config.rerank.apiKey` |
| 调整 STM 存活时间                   | `config.router.stmTTLMs`                                         |
| 使用 LLM 进行记忆分类               | `config.router.classifyMode: "llm_only"`                         |
| 脱敏敏感字段                        | `config.collector.redactKeys`                                    |
| 排除某些工具的采集日志              | `config.collector.excludeTools`                                  |
| 全文搜索语言设置                    | `config.store.ftsLanguage`                                       |
| 各记忆层容量上限                    | `config.store.tables.<层名>.maxEntries`                          |
| 调整压缩触发频率                    | `config.compactor.compaction.intervalMs`                         |
| 生成 / 关闭 MEMORY.md 快照          | `config.compactor.memoryMd.enabled`                              |
| 禁用整个插件（不卸载）              | `plugins.entries.memory-4layer.enabled: false`                   |
| 切换到其他记忆插件                  | `plugins.slots.memory: "<other-plugin-id>"`                      |
| 暂时关闭记忆功能                    | `plugins.slots.memory: "none"`                                   |
