# BetaV0.1.1 PostgreSQL catalog metadata

## 变更

- 增强 PostgreSQL `describeTable()`，返回估算行数、视图定义、索引和约束。
- 扩展共享 schema 类型，新增字段级索引/唯一提示和表级 catalog metadata。
- 增强 Schema RAG 文档构建，把索引、约束、视图定义和估算行数写入 Agent 可消费上下文。
- 增加 Agent 工具层测试，确认 `describe_table` 能暴露 catalog metadata。
- 增加真实 PostgreSQL 测试，覆盖普通索引、主键索引、单字段唯一、复合唯一、check 约束和视图定义。

## 开源与依赖

本版本不新增依赖。当前能力直接基于 PostgreSQL catalog 实现，避免为了 metadata 读取引入 ORM、RAG 框架、向量库或 native parser。

后续可评估：

- SQLite FTS5 / sqlite-vec：本地 RAG 持久化检索。
- LlamaIndex.TS / Haystack：借鉴 storage、retriever、eval 分层。
- PostgreSQL parser：用于 SQL AST、血缘和自动改写。

所有第三方能力必须隔离在 adapter 或官方插件边界后面，不能污染核心接口。

## 测试

已覆盖的局部测试：

- `packages/core-rag/test/schema-catalog-metadata.test.ts`
- `packages/core-rag/test`
- `packages/core-agent/test/schema-rag-tools.test.ts`
- `packages/core-db/test/postgres.integration.test.ts` 中新增 PostgreSQL catalog metadata 场景。

完整门禁以本次提交记录为准。

## 发布风险

- `rowEstimate` 是 PostgreSQL 统计估算，不表示精确 count。
- catalog 定义文本需要在 LLM 上下文中截断和审计。
- 多数据库支持时必须各 driver 独立实现 metadata 映射。
