# BetaV0.1.1 RAG explicit reference on-demand indexing

## 变更

- 新增 Schema RAG 显式引用解析。
- `search_schema` 底层检索现在会优先处理 `@schema.table` 和 `@schema.table.column`。
- 新增 RAG 增量 upsert，支持把按需读取的表详情合并进已有索引。
- 新增 catalog reader 按需索引入口 `ensureSchemaCatalogTablesIndexed()`。
- upsert 后会保存 snapshot，重启恢复后仍可检索新增表。
- 真实 PostgreSQL 业务测试新增冷门表按需索引场景。

## 依赖与打包

本版本不新增依赖，不引入 native module，不增加 Electron 打包风险。

## 已知限制

- `@a.b` 按 `schema.table` 处理，不按 `table.column` 处理。
- 裸表名在多个 schema 中存在时会拒绝猜测。
- 当前按需索引入口已在 core 层完成，Agent 工具自动触发还在下一切片接入。

## 测试

通过：

- `packages/core-rag/test`
- `packages/core-tools/test/agent-rag-business-scenario.test.ts`
- `pnpm test:postgres`

完整质量门禁以提交记录为准。
