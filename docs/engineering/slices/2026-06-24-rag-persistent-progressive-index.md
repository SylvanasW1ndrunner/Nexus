# 2026-06-24 RAG 持久化快照与渐进索引状态切片

## 范围

- 模块：`packages/core-rag`
- 目标：连接级 Schema RAG 快照、重启恢复、渐进索引状态合同。
- 非目标：正式前端 UI、向量检索、SQLite FTS5 落地、真实 PostgreSQL catalog 接线、live LLM eval。

## 验收标准

- 快照必须按 `connectionId` 隔离。
- 快照损坏、缺失、旧版本时不得阻断数据库连接或后续重新索引。
- 新 `SchemaRagEngine` 必须能加载快照并继续执行 `search()`、`buildContext()`。
- 渐进索引状态必须能表达 `idle`、`skeleton`、`hot_tables`、`long_tail`、`ready`、`failed`。
- 不引入新的 runtime/native 依赖，避免当前阶段增加 Electron 打包风险。

## 三 Agent 分工记录

- 项目架构师 Agent：确认持久化和渐进索引属于 `core-rag` 基础设施，不应插件化；建议保留 adapter 边界，把 eval、embedding、reranker 等外围能力插件化。
- 测试 Agent：建议新增真实文件系统快照、恢复、损坏降级、渐进状态测试；真实 PostgreSQL 和 live LLM 在后续 catalog/Agent 接线切片进入门禁。
- 开发者 Agent：实现 snapshot store、progressive indexer、engine 恢复入口和状态查询，并补充测试与文档。

## 验证证据

- `vitest`：`packages/core-rag/test/schema-rag-snapshot-store.test.ts`、`progressive-schema-rag-indexer.test.ts`、`schema-rag-engine.test.ts`、`retrieval-evaluation.test.ts`，共 23 个 case 通过。
- `tsc`：`packages/core-rag/tsconfig.json --noEmit` 通过。

## 残余风险

- 当前渐进索引状态是合同先行，内部仍一次性构建完整索引；下一步需要接入真实分批抽取。
- 当前快照格式是 JSON v1，适合验证恢复路径；大 schema 性能和查询能力需要 SQLite FTS5/sqlite-vec adapter 评估后再升级。
- 还没有 schema revision 和增量删除策略，后续连接到真实 PostgreSQL catalog 后必须补齐。
