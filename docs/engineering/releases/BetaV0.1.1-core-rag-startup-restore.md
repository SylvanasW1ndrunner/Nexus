# BetaV0.1.1 core-rag 启动批量恢复

## 变更

- `ProgressiveSchemaRagIndexer` 新增 `restoreAll`。
- 支持启动时批量恢复本地 Schema RAG snapshot。
- 支持报告损坏 snapshot，不阻断其他连接恢复。
- 支持按连接 ID 过滤恢复范围。

## 验证

- `tsc -p packages/core-rag/tsconfig.json --noEmit`
- `vitest run packages/core-rag/test/progressive-schema-rag-indexer.test.ts packages/core-rag/test/schema-rag-snapshot-store.test.ts --passWithNoTests`
- `eslint packages/core-rag/src/progressive-schema-rag-indexer.ts packages/core-rag/test/progressive-schema-rag-indexer.test.ts`

## 风险

- 本切片不包含 desktop 启动接线。
- 当前仍是 JSON snapshot 持久层，后续向量/FTS 存储需要单独切片。
