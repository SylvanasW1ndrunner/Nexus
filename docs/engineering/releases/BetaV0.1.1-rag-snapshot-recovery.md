# BetaV0.1.1 RAG 快照恢复韧性

## 变更

- 增加 Schema RAG 快照诊断加载接口。
- 损坏快照自动隔离为 `.corrupt-{timestamp}` 文件。
- 渐进索引恢复流程在坏快照场景返回 `failed` 状态，不再依赖调用方捕获异常。
- 保留原有 `load()` 兼容合同。

## 验证

- `vitest run packages/core-rag/test/schema-rag-snapshot-store.test.ts packages/core-rag/test/progressive-schema-rag-indexer.test.ts --passWithNoTests`
- `tsc -p packages/core-rag/tsconfig.json --noEmit`
- `eslint packages/core-rag/src/schema-rag-snapshot-store.ts packages/core-rag/src/progressive-schema-rag-indexer.ts packages/core-rag/test/schema-rag-snapshot-store.test.ts packages/core-rag/test/progressive-schema-rag-indexer.test.ts`

## 依赖与打包

本次没有新增依赖，不影响 Electron 打包体积和 native module 风险。

## 已知边界

- 当前快照仍是 JSON 文件，后续需要迁移到 SQLite/FTS/vector 持久化索引。
- `.corrupt-*` 文件暂不自动清理，后续接入诊断报告和保留策略。
