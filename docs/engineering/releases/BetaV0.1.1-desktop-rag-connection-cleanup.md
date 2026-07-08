# BetaV0.1.1 - 桌面连接删除清理 Schema RAG 快照

## 变更摘要

本版本把 Schema RAG 快照清理能力接入桌面主进程连接删除流程。用户删除数据库连接时，应用会同步清理该连接对应的 RAG 持久化快照和内存索引，避免已删除连接继续被 Agent 检索到。

## 影响范围

- `apps/desktop/src/main/connection-workflow.ts`
- `apps/desktop/src/main/main.ts`
- `apps/desktop/src/main/connection-workflow.test.ts`
- `docs/engineering/modules/desktop.md`
- `docs/engineering/modules/core-rag.md`

## 行为说明

- 删除连接时先断开数据库 driver。
- 随后删除 `userData/schema-rag-snapshots` 下对应连接的快照。
- 然后清理共享 `SchemaRagEngine` 的内存索引。
- RAG 清理成功后再删除连接配置和凭据。
- 如果 RAG 快照清理失败，连接配置和凭据保留，调用方可以重试删除。

## 安全与打包

- 无新增依赖。
- 不改变 renderer UI。
- 不写入或输出数据库密码、API key。
- 删除范围由 `SchemaRagSnapshotStore` 限定在快照目录内的连接级快照文件。

## 验证记录

已完成：

```powershell
pnpm exec vitest run apps/desktop/src/main/connection-workflow.test.ts
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
