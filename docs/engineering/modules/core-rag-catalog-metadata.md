# core-rag catalog 元数据消费

## 目标

Schema RAG 需要理解真实数据库结构，而不只是表名和字段名。本模块补充 `core-rag` 对 PostgreSQL catalog metadata 的消费，使 Agent 在回答业务问题、规划 SQL、解释 schema 时能看到：

- 表估算行数。
- 索引名称、方法、字段和唯一性。
- 主键、唯一、check、外键等约束。
- 视图定义。
- 字段是否被索引、是否为单字段唯一。

## 实现入口

核心实现位于 `packages/core-rag/src/schema-documents.ts`：

- `buildSchemaDocuments()` 将 `TableDetail[]` 转为稳定的 schema 文档。
- 表级文档文本包含估算行数、索引、约束和视图定义摘要。
- 字段级文档文本包含索引和唯一性提示。
- 文档 metadata 保留结构化 `rowEstimate`、`indexes`、`constraints`、`viewDefinition`，供后续 reranker、可视化、审计和 Agent 工具使用。

`SchemaRagEngine.describeTable()` 和 Agent 工具 `describe_table` 会复用这些文档文本，因此 catalog metadata 会进入实际 Agent 上下文，而不是只停留在底层对象里。

## LLM 上下文边界

RAG 文档会把视图定义和约束定义裁剪为短文本，避免把过长 DDL 直接塞进模型上下文。底层结构化 metadata 仍然保留完整字符串，后续 UI 或审计工具可以按需展示。

对 LLM 注入时仍需遵守以下边界：

- 不注入数据库连接凭据、API key、认证 token。
- 不让 Agent 根据约束定义直接执行写操作。
- 对 DDL、索引和 check 约束做只读解释，写操作仍走 `core-db` 的 SQL 安全与确认门禁。

## 插件化边界

本能力属于核心 Schema RAG 文档建模，不作为独立官方插件。适合插件化的是围绕它扩展的能力，例如：

- PostgreSQL catalog reader 官方插件。
- 其他数据库的 catalog reader 插件。
- embedding provider 插件。
- reranker 插件。
- RAG eval 插件。
- ER 图导出插件。

插件不能改变 `core-rag` 的稳定合同，只能通过 reader、indexer、retriever、provider 或 exporter adapter 接入。

## 开源复用评估

本切片不新增 LlamaIndex、Haystack、LangChain、pgvector、sqlite-vec 或 reranker 依赖。原因：

- 当前目标是 schema metadata 的结构化消费，现有内存索引已经足够验证业务闭环。
- 向量索引和 rerank 会带来模型下载、离线可用、Electron 打包、native module 和许可证评估问题。
- 后续接入时应把第三方库隔离在 adapter 内，不能让外部框架类型污染 `core-rag` 稳定接口。

优先候选方向：

- SQLite FTS5：本地全文索引优先候选，适合替换当前轻量 token 检索。
- sqlite-vec：本地向量检索候选，但需要评估 pre-v1 兼容性和 Electron 打包。
- LlamaIndex.TS / Haystack：可借鉴 storage、retriever、eval 分层，但不应直接决定 DBAgent 的核心合同。

## 测试

新增默认测试覆盖：

- 表文档包含估算行数、索引、check 约束和视图定义。
- 字段文档保留索引和唯一性 metadata。
- `search()` 能通过索引名、约束名、视图定义相关词召回目标表或视图。
- `describeTable()` 输出给 Agent 的文本包含 catalog metadata。

新增 Agent 工具层测试覆盖：

- `describe_table` 工具返回的上下文包含索引、约束和估算行数，保证 Agent 实际可见。
