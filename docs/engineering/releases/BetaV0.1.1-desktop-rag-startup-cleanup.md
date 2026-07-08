# BetaV0.1.1 - 桌面启动期清理无主 Schema RAG 快照

## 变更摘要

本版本在桌面主进程启动流程中接入 Schema RAG 快照维护。应用启动时会读取当前连接清单，并删除不再属于任何连接的 RAG 快照，同时清理损坏快照，减少本地磁盘残留和过期 schema 被误用的风险。

## 影响范围

- `apps/desktop/src/main/schema-rag-startup-cleanup.ts`
- `apps/desktop/src/main/schema-rag-startup-cleanup.test.ts`
- `apps/desktop/src/main/main.ts`
- `docs/engineering/modules/desktop.md`
- `docs/engineering/modules/core-rag.md`

## 行为说明

- 启动时读取 `connections.json` 中的连接 ID。
- 调用 `SchemaRagSnapshotStore.cleanupInactive()` 清理无主快照。
- 默认删除损坏快照。
- 如果连接清单读取失败，不执行清理，只记录错误并继续启动。
- 日志只记录计数摘要，不记录快照内容、数据库凭据或 API key。

## 安全与打包

- 无新增依赖。
- 不改变 renderer UI。
- 不接触数据库密码、API key 或真实业务数据。
- 删除行为仍由 `core-rag` store 限定在快照根目录内的正式快照文件。

## 验证记录

已完成：

```powershell
pnpm exec vitest run apps/desktop/src/main/schema-rag-startup-cleanup.test.ts
pnpm turbo typecheck --filter=@dbagent/desktop
pnpm turbo lint --filter=@dbagent/desktop
pnpm turbo test --filter=@dbagent/desktop
pnpm turbo typecheck
pnpm turbo lint
pnpm turbo test --concurrency=1
pnpm smoke
git diff --check
```

结果：全部通过。仓库 secret 扫描没有命中 SiliconFlow 或其他测试 API key。
