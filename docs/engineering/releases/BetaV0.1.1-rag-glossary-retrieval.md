# BetaV0.1.1 - Schema RAG 业务术语检索增强

## 背景

数据工程师和分析师经常用业务词提问，例如 GMV、客单价、活跃用户、留存等。这些词不一定出现在数据库表名或字段名中。仅靠表名、字段名和注释做词法检索时，Agent 可能无法召回正确 schema，导致后续 SQL 生成缺少关键表或字段。

本切片在不引入 embedding 和向量库的前提下，为 Stage 1 Schema RAG 增加业务术语 glossary 能力。

## 变更内容

- `SchemaRagIndexInput` 新增 `glossary`。
- 新增 `SchemaRagGlossaryEntry`：
  - `term`：标准业务词。
  - `aliases`：别名，例如 AOV、成交额。
  - `description`：业务解释。
  - `documentIds`：该业务词应召回的 schema 文档。
  - `weight`：可选权重。
- `SchemaRagEngine.index()` 会清洗 glossary：
  - 去掉空 term。
  - 去掉指向不存在 schema 文档的 id。
  - 丢弃没有有效文档的词条。
- `search()` 命中业务词或别名时，对目标文档加权，并在 `reasons` 中写入 `glossary:<term>`。
- glossary 按 connection 隔离，不会跨连接污染检索结果。

## 开源评估

本切片不新增依赖。当前能力属于结构化 schema 检索的轻量规则层，不需要引入通用 RAG 框架或向量库。

后续如果接入 embedding、reranker、RRF、向量存储或 LLM judge，应按 `docs/engineering/open-source-first.md` 评估 LlamaIndex、Haystack、pgvector、SQLite FTS/向量扩展等成熟方案，记录许可证、Electron 打包、离线、模型下载和安全边界。

## 测试覆盖

- `GMV` 这类业务词能召回 `orders.total_amount` 和订单表。
- glossary 命中会在结果原因中保留 `glossary:GMV`，便于调试和 Agent 解释。
- 指向不存在文档的 glossary 项会被忽略，避免错误配置污染检索。
- 不同连接的 glossary 相互隔离。
- 检索评估器覆盖“最近 30 天客单价”这类真实用户问题，验证 must/should schema 召回。

## 已知限制

- 当前 glossary 需要调用方显式提供，尚未从工作空间数据字典、用户反馈或 Agent 生成文档中自动抽取。
- 当前仍是规则检索，不提供语义相似召回；embedding 和 rerank 属于后续切片。
