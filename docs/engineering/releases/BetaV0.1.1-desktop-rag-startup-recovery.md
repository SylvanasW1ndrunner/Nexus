# BetaV0.1.1 - 桌面启动期恢复活跃 Schema RAG 快照

## 变更摘要

本版本让桌面主进程在启动时恢复活跃连接的 Schema RAG 快照。应用重启后，如果某个连接已有可用快照，主进程会将其加载到共享 `SchemaRagEngine`，让 Agent 的 schema 检索工具直接使用持久化索引。

## 影响范围

- `apps/desktop/src/main/schema-rag-startup-cleanup.ts`
- `apps/desktop/src/main/schema-rag-startup-cleanup.test.ts`
- `apps/desktop/src/main/main.ts`
- `docs/engineering/modules/desktop.md`
- `docs/engineering/modules/core-rag.md`

## 行为说明

- 启动时读取当前连接清单。
- 先执行无主快照清理。
- 再加载活跃连接对应的快照。
- 可用快照通过 `SchemaRagEngine.loadIndex()` 进入共享内存索引。
- 缺失快照不算错误。
- 单个快照损坏、读取失败或 hydrate 失败不会影响其他连接。

## 安全与打包

- 无新增依赖。
- 不改变 renderer UI。
- 不接触数据库密码、API key 或真实业务数据。
- 日志只输出恢复摘要，不输出快照内容。

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
