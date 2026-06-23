# BetaV0.1.1 - Agent Schema RAG 工具接线

## 背景

当前阶段先完成后端能力，前端 UI 延后。Agent 已有 ReAct 主循环、工具注册、权限控制和上下文压缩；Schema RAG 已有内存索引、glossary 检索和上下文构建。但二者之间缺少稳定工具适配层，导致 Agent 后续回答数据库问题时无法通过标准工具合同检索 schema。

## 本次变更

- `core-rag` 新增工具级查询接口：
  - `hasIndex()`
  - `listTables()`
  - `describeTable()`
  - `getRelations()`
- `describeTable()` 和 `getRelations()` 支持 `schema.table` 与 `schema + table` 两种表引用方式。
- 裸表名在多 schema 中存在歧义时返回明确错误，避免 Agent 猜错生产表。
- `core-agent` 新增 `registerSchemaRagTools()`，注册四个只读工具：
  - `search_schema`
  - `describe_table`
  - `list_tables`
  - `get_relations`
- RAG 工具全部标记为 `safe + readonly`，并继续受 `allowedTools` 运行白名单约束。
- `registerSchemaRagTools()` 支持 `skipExistingTools`，供组合工具包跳过已有同名工具。
- `core-tools/registerDatabaseTools()` 复用 RAG 工具适配层，避免与实时数据库工具 `list_tables`、`describe_table` 发生重复注册；组合后新增 `get_relations`，并保留兼容的 `build_schema_context`。

## 开源依赖决策

本切片不新增第三方依赖。当前目标是把已有结构化 RAG 结果接入 Agent Tool Registry，外部 RAG/Agent 框架不能直接减少这一层 typed adapter 的工作量。

后续如果接入向量索引、FTS 持久化、RRF/rerank、RAG eval 或更复杂 Agent workflow，应优先评估成熟开源方案，例如 SQLite FTS/sqlite-vec、LlamaIndex、Haystack、LangGraph 等，并按 `docs/engineering/open-source-first.md` 记录许可证、打包、离线、安全和测试影响。

## 测试

- `packages/core-rag/test/schema-rag-engine.test.ts`
  - 列出已索引表。
  - 描述单表字段和直接关联表。
  - 返回单表关系上下文。
  - 多 schema 裸表名歧义时拒绝猜测。
- `packages/core-agent/test/schema-rag-tools.test.ts`
  - RAG 工具注册为稳定、只读、安全的模型可见合同。
  - GMV glossary 场景能召回 `public.orders.total_amount`。
  - 无活动连接时拒绝调用。
  - broader database tool pack 已有同名工具时可跳过重复注册。
  - `ReactAgent` 通过 `search_schema` 检索 schema 后再给出业务答案。
- `packages/core-tools/test/db-tools.test.ts`
  - 数据库工具与 RAG 工具组合注册时没有重复 tool name。
  - `get_relations` 和 `build_schema_context` 在组合工具包内保持可用。

## 验证命令

```powershell
node .\node_modules\typescript\bin\tsc -p packages\core-rag\tsconfig.json --noEmit
node .\node_modules\typescript\bin\tsc -p packages\core-rag\tsconfig.json
node .\node_modules\typescript\bin\tsc -p packages\core-agent\tsconfig.json --noEmit
node .\node_modules\typescript\bin\tsc -p packages\core-agent\tsconfig.json
node .\node_modules\typescript\bin\tsc -p packages\core-tools\tsconfig.json --noEmit
node .\node_modules\vitest\vitest.mjs run packages\core-rag\test\schema-rag-engine.test.ts
node .\node_modules\vitest\vitest.mjs run packages\core-agent\test\schema-rag-tools.test.ts
node .\node_modules\vitest\vitest.mjs run packages\core-tools\test\db-tools.test.ts
```

## 已知边界

- 当前仍是内存索引，尚未实现 per-connection SQLite RAG 持久化。
- 当前未接入真实 embedding/rerank；语义增强依赖 glossary 和结构化关系扩展。
- 本切片未新增 IPC，桌面主进程后续可在激活连接后注册默认 connectionId 的 RAG 工具。
