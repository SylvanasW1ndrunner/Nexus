# BetaV0.1.1 - Schema RAG 快照清单与清理

## 变更摘要

本版本为 `core-rag` 增加连接级快照清单和过期清理能力。产品层面解决两个问题：

- 应用启动时可以审计本地已有 RAG 快照，而不是只能按连接盲读。
- 用户删除连接后，上层可以安全清理无主 Schema RAG 快照，避免本地文件长期残留。

## 影响范围

- `packages/core-rag/src/schema-rag-snapshot-store.ts`
- `packages/core-rag/test/schema-rag-snapshot-store.test.ts`
- `docs/engineering/modules/core-rag.md`
- `docs/engineering/slices/2026-07-08-rag-snapshot-cleanup.md`

## 接口

- `SchemaRagSnapshotStore.list()`
- `SchemaRagSnapshotStore.cleanupInactive({ activeConnectionIds, removeInvalid })`

接口仍属于 core 层，不依赖 Electron，不暴露 UI 合同。

## 安全与打包

- 无新增依赖。
- 不涉及数据库密码、API key 或用户数据内容输出。
- 删除范围限制在快照根目录下的正式 `.schema-rag.json` 文件。
- 默认不删除损坏快照，除非调用方显式设置 `removeInvalid: true`。

## 验证记录

已完成：

```powershell
pnpm exec vitest run packages/core-rag/test/schema-rag-snapshot-store.test.ts
pnpm turbo typecheck --filter=@dbagent/core-rag
pnpm turbo lint --filter=@dbagent/core-rag
pnpm turbo test --filter=@dbagent/core-rag
pnpm turbo typecheck
pnpm turbo lint
pnpm turbo test --concurrency=1
pnpm smoke
```

结果：全部通过。仓库 secret 扫描没有命中测试 API key。
