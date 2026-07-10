# 2026-07-10：core-rag 混合检索边界

## 背景

产品文档要求 Schema RAG 支持显式引用、关键词、业务术语、图扩展、后续向量检索和 rerank。当前 `core-rag` 已有内存索引、snapshot 恢复和渐进状态合同，但 `SchemaRagEngine.search()` 仍是单文件内部打分，缺少可替换 retriever 边界。

## 本轮实现

- 新增 `hybrid-schema-retriever.ts`，作为默认纯 TypeScript 混合检索实现。
- `SchemaRagEngine.search()` 改为委托默认 retriever。
- 新增 `SchemaRagRetriever`、`SchemaRagRetrievalChannel`、`SchemaRagScoreDetail` 类型。
- `SchemaRagSearchRequest` 增加 `expandHops`、`tokenBudget` 合同字段。
- 显式引用解析支持 quoted identifier 中包含点号。
- 图扩展排序改为同表上下文优先、相关表其次、远端列最后，避免小结果集丢掉关键列或 JOIN 表。
- `pnpm-workspace.yaml` 明确批准当前已有构建脚本依赖：`electron`、`esbuild`、`node-pty`，修复本地 pnpm 11 的 dependency policy gate。

## 依赖决策

本轮不引入 `better-sqlite3` 或 `sqlite-vec`。

原因：

- 当前目标是稳定检索合同和业务行为，不是一次性切 native storage。
- native SQLite 依赖会扩大 Electron 打包和跨平台风险。
- 后续 SQLite FTS5/vector 可以通过 `SchemaRagRetriever` 和 storage adapter 接入，不需要现在污染公共接口。

## 验证

- `pnpm --filter @dbagent/core-rag typecheck`
- `pnpm --filter @dbagent/core-rag test`
- `pnpm --filter @dbagent/core-agent typecheck`
- `pnpm --filter @dbagent/core-tools typecheck`
- `pnpm exec vitest run packages/core-tools/test/agent-rag-business-scenario.test.ts --pool=forks`

## 后续

- 做真实分阶段 catalog 抽取，避免当前 progressive indexer 只是状态合同。
- 增加 token-aware context builder。
- 开 SQLite FTS5/sqlite-vec dependency spike，单独验证 Electron 打包和离线安装。
- 为 live PostgreSQL schema fixture 增加默认门控测试，覆盖电商、流量分析和审计 schema。
