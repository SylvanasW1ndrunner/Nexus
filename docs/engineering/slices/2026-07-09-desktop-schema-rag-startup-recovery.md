# 2026-07-09 desktop Schema RAG 启动恢复接线

## 范围

本切片把 core-rag 的 `restoreAll` 接到 desktop 启动流程，并新增 Agent 可调用的恢复诊断工具。

改动包括：

- `recoverSchemaRagSnapshotsAtStartup` 改为使用 `ProgressiveSchemaRagIndexer.restoreAll`。
- desktop 主进程创建共享 `ProgressiveSchemaRagIndexer`。
- 保存最近一次 `SchemaRagStartupRecoverySummary`。
- 新增官方工具 `get_schema_rag_startup_recovery`。
- 更新官方插件 manifest 和权限策略测试。

## 验收结果

- `apps/desktop` 类型检查通过。
- `packages/core-tools` 类型检查通过。
- `schema-rag-startup-cleanup`、`agent-tool-bootstrap`、`official-plugin-registry` 相关测试通过。
- 指定文件 ESLint 通过。

## 后续

- 最终 UI 可以展示该 summary 作为启动诊断。
- 后续如果引入 SQLite/FTS/vector 持久层，应继续复用当前 desktop summary 合同。
