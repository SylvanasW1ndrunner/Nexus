# 2026-07-09 core-rag 启动批量恢复

## 范围

本切片补齐 Schema RAG 启动恢复能力，让后端可以一次性恢复本地已有 snapshot，并返回恢复诊断。

改动包括：

- `ProgressiveSchemaRagIndexer` 新增 `restoreAll`。
- 新增 `SchemaRagRestoreAllResult` 返回恢复成功、损坏 snapshot、失败摘要。
- 补充真实文件系统测试，覆盖多连接恢复、损坏 snapshot、连接过滤和无 store 模式。

## 设计决策

本切片不引入新的向量库或 RAG 框架，只复用现有 `SchemaRagSnapshotStore`。原因是当前目标是启动恢复编排，新增 native/vector 依赖会扩大打包风险，且不会直接提高本切片的可靠性。

## 验收结果

- `packages/core-rag` 类型检查通过。
- `packages/core-rag/test/progressive-schema-rag-indexer.test.ts` 和 `packages/core-rag/test/schema-rag-snapshot-store.test.ts` 通过。
- 指定文件 ESLint 通过。

## 后续

- desktop 主进程启动时可以调用 `restoreAll`，恢复所有最近连接的 Schema RAG index。
- 后续如接入 SQLite/FTS/vector，应保留当前 batch restore 合同，在 adapter 内替换存储实现。
