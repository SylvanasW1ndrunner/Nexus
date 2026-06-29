# BetaV0.1.1 Schema RAG 真实 catalog 渐进索引

## 本次变更

- 新增 `SchemaCatalogReader` 合约，用于把数据库 catalog 元数据接入 Schema RAG。
- 新增 `indexSchemaCatalogFromReader()`，统一处理 schema 过滤、并发表详情读取、局部失败 warning 和渐进索引构建。
- 真实 PostgreSQL 业务验收改为通过新入口建立 RAG 索引，避免测试继续手写 `TableDetail[] -> rag.index()` 流程。
- 受控 fixture 建表/清理 SQL 显式 `confirmed: true`，保留 SQL 安全确认边界。

## 用户价值

- 后续连接真实 PostgreSQL 后，可以从数据库元数据直接生成可检索 Schema RAG，而不是依赖前端或测试层手动传表结构。
- 远程数据库部分表权限不足或元数据读取失败时，可以先索引可用表，并把失败原因作为 warnings 暴露给后台任务和未来 UI。
- 多数据库扩展边界更清晰：MySQL、SQLite、企业数据目录或 MCP 元数据服务只需要实现相同 reader 合约。

## 开源与依赖

本版本不新增第三方依赖。当前切片只做 catalog adapter 和现有渐进索引接线；引入通用 RAG 框架、向量库或 SQL parser 不会提升当前能力，反而增加 Electron 打包、离线安装和许可证审查成本。

后续 embedding、rerank、SQLite FTS/sqlite-vec、RAG eval、metadata extractor 都应优先评估成熟开源项目，并通过 adapter 或官方插件接入，不能把第三方框架类型暴露为稳定接口。

## 测试

已执行：

- `pnpm --filter @dbagent/core-rag test`
- `node .\node_modules\typescript\bin\tsc -p packages/core-rag/tsconfig.json --noEmit`
- `node .\node_modules\typescript\bin\tsc -p packages/core-tools/tsconfig.json --noEmit`
- `node .\node_modules\vitest\vitest.mjs run packages/core-tools/test/agent-rag-business-scenario.test.ts`
- `DBAGENT_RUN_POSTGRES_TESTS=1 node .\node_modules\vitest\vitest.mjs run packages/core-tools/test/agent-rag-business-scenario.test.ts`

说明：

- `@dbagent/core-rag` 单元测试覆盖 catalog reader 成功、局部失败、严格失败和 listTables 失败。
- 真实 PostgreSQL 验收会实际建表、抽取 catalog、建立渐进 RAG 索引，并让 Agent 使用 schema search 与数据库查询工具完成业务任务。
- SiliconFlow live 测试本切片未运行，因为本次变更不改变 LLM provider 或 Agent 推理循环。

## 已知风险

- 当前 PostgreSQL catalog 仍只覆盖表、视图、字段、主键、外键和注释；索引、唯一约束、check 约束、分区、视图定义和统计信息尚未纳入 RAG 文档。
- `ProgressiveSchemaRagIndexer` 当前仍是一次性构建完整内存索引，只提供阶段状态合约；真实后台分批索引、取消和 checkpoint 仍需后续开发。
- 大型 schema 下的性能上限需要新增真实压测数据集验证。
