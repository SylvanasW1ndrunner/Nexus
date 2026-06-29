# 2026-06-29 Schema RAG 真实 PostgreSQL catalog 渐进索引切片

## 背景

当前开发路线是“功能优先，前端最后统一重建”。`docs/product/02-rag-design.md` 要求 Schema RAG 的渐进索引最终来自数据库 catalog，而不是由测试或 UI 手动拼装 `TableDetail[]`。此前 `ProgressiveSchemaRagIndexer` 已具备状态与快照能力，但真实数据库元数据读取流程仍散落在测试里。

本切片把 `listTables -> describeTable -> progressive index` 收敛为 core-rag 的独立入口，保持 RAG 引擎不直接依赖 PostgreSQL driver，也为后续 MySQL、SQLite、MCP 数据源和官方插件化数据库适配器预留统一边界。

## 实现范围

- `packages/core-rag/src/schema-catalog-indexer.ts`
  - 新增 `SchemaCatalogReader` 合约，只要求实现 `listTables()` 和 `describeTable()`。
  - 新增 `indexSchemaCatalogFromReader()`，负责 schema 过滤、表详情并发读取、局部失败 warning、严格模式失败返回、以及调用 `ProgressiveSchemaRagIndexer`。
  - 返回 `tables`、`requestedTableCount`、`indexedTableCount`、`skippedTableCount`、`warnings` 和渐进索引状态，便于 Agent、后台任务和未来 UI 做可观测展示。
- `packages/core-rag/src/index.ts`
  - 导出 catalog indexing 合约和入口。
- `packages/core-tools/test/agent-rag-business-scenario.test.ts`
  - 真实 PostgreSQL 业务验收改用 `indexSchemaCatalogFromReader()`，不再手写 catalog 抽取与 `rag.index()`。
  - fixture 初始化和清理 SQL 显式传入 `confirmed: true`，验证安全确认机制没有被绕过。
  - `expectOk()` 失败时输出错误码、消息和 detail，真实依赖失败可以直接定位。

## 合约边界

`core-rag` 只依赖 `@dbagent/shared` 的 `Result` 和 `TableDetail` 类型，不依赖 `core-db`。原因：

- RAG 不应知道 PostgreSQL、MySQL 或其他数据源的连接生命周期。
- 多数据库支持只需要在对应 driver 或官方插件里实现 `SchemaCatalogReader`。
- 后续如果接入外部 metadata extractor、MCP server、数据目录或企业元数据平台，也可以通过同一 reader 合约进入。

`continueOnTableError` 默认是 `true`，面向远程数据库和权限不完整的生产场景：单张表 describe 失败时可以先索引可用部分，同时把失败表写入 warnings。测试和强一致后台任务可以设置 `false`，任何表失败即返回错误。

## 开源复用评估

本切片不引入 LlamaIndex、Haystack、LangChain、RAGAS、pgvector、sqlite-vec 或新的 SQL parser。原因：

- 当前目标是数据库 catalog 到现有 Schema RAG 渐进索引的接线，不涉及 embedding、rerank 或通用文档切块。
- 现有 `pg` driver 已能提供稳定 `TableDetail`，新增依赖不会提高本切片质量，反而增加 Electron 打包和离线安装风险。
- 参考成熟项目的分层思想：metadata extractor、indexer、retriever、storage 必须隔离在 adapter 后面，不能把第三方框架类型暴露为 DBAgent 稳定合约。

后续可以把以下能力作为官方插件或 adapter：

- PostgreSQL metadata extractor 官方插件。
- MySQL metadata extractor 官方插件。
- 本地 SQLite FTS/sqlite-vec 检索插件。
- RAG eval/report 官方插件。
- reranker/embedding provider 插件。

## 测试策略

- 单元测试：`packages/core-rag/test/schema-catalog-indexer.test.ts`
  - schema 过滤后构建渐进索引。
  - 单表 describe 失败时继续索引可用表并输出 warnings。
  - 严格模式下返回 describe 错误。
  - `listTables` 失败时不调用 `describeTable`，直接返回连接错误。
- 真实 PostgreSQL 验收：`packages/core-tools/test/agent-rag-business-scenario.test.ts`
  - `DBAGENT_RUN_POSTGRES_TESTS=1` 启用。
  - 实际创建电商、流量分析、广告投放、退款等业务表。
  - 从 PostgreSQL catalog 抽取 schema。
  - 通过 `indexSchemaCatalogFromReader()` 建立 Schema RAG。
  - Agent 调用 `search_schema` 和 `query_database` 完成渠道 GMV、退款率和 ROI 任务。

## 验收结果

- `@dbagent/core-rag` 单元测试通过。
- `@dbagent/core-rag` 类型检查通过。
- `@dbagent/core-tools` 类型检查通过。
- 真实 PostgreSQL 业务验收在本地通过。

## 后续扩展

- 在 `core-db` 增加更完整的 PostgreSQL catalog 字段：索引、唯一约束、check 约束、分区、视图定义和估算行数。
- 给 catalog indexing 增加取消、进度事件和后台任务 checkpoint。
- 把 PostgreSQL catalog reader 注册为官方插件 manifest，明确权限：读取 schema metadata，不读取业务数据。
- 为远程数据库补充网络断连、权限不足、单 schema 大表量和 statement timeout 的真实测试。
