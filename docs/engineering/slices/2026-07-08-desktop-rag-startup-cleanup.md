# 2026-07-08 桌面启动期清理无主 Schema RAG 快照

## 背景

连接删除流程已经能清理该连接对应的 Schema RAG 快照，但真实用户环境里仍可能出现无主快照：

- 旧版本删除连接时没有清理快照。
- 用户手动迁移或编辑连接配置。
- `connections.json` 回滚、损坏后恢复，导致快照目录与连接清单不一致。
- 损坏快照长期残留，占用磁盘并干扰诊断。

本切片把 `core-rag` 的 `cleanupInactive()` 接入桌面启动流程，确保应用每次启动时都能做一次安全的本地快照维护。

## 实现内容

- 新增 `apps/desktop/src/main/schema-rag-startup-cleanup.ts`。
- 服务只依赖两个接口：
  - `connections.list()`：读取当前活跃连接 ID。
  - `snapshots.cleanupInactive()`：执行快照根目录内的安全清理。
- `main.ts` 在 `app.whenReady()` 后、窗口创建前调用清理服务。
- 清理默认 `removeInvalid: true`，删除无主快照和损坏快照。
- 日志只记录计数摘要，不记录快照内容和凭据。

## 恢复与失败语义

- 如果连接清单读取失败，清理服务直接失败，调用方记录日志并继续启动应用。
- 连接清单不可用时不执行任何快照删除，避免把仍属于用户连接的快照误判为无主。
- 删除失败会被记录为启动期维护错误，不阻塞主窗口启动；用户后续仍可删除连接或重新索引。

## 模块化与插件判断

本能力不是官方插件候选。它属于本地数据一致性维护，必须由桌面主进程在启动生命周期中稳定执行。

适合插件化的是外围能力，例如 PostgreSQL/MySQL catalog reader、embedding provider、reranker、RAG eval 和业务术语维护工具。这些能力可以在官方插件中实现，但不应接管核心生命周期清理。

## 开源方案评估

本轮没有新增依赖。

- 需求是启动期文件生命周期维护，不涉及检索算法、向量存储或外部服务。
- 已有 `SchemaRagSnapshotStore` 使用 Node 原生 `fs/promises` 完成安全清理，足够覆盖当前场景。
- 引入 SQLite、sqlite-vec、LlamaIndex 或 LangChain 不会降低本切片复杂度，反而增加打包、native module 和迁移风险。

## 测试

新增 `apps/desktop/src/main/schema-rag-startup-cleanup.test.ts`：

- 默认删除无主快照和损坏快照，并返回计数摘要。
- 支持调用方关闭损坏快照删除。
- 当连接清单读取失败时，不调用快照清理器，避免误删。

已运行：

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

结果：全部通过。提交前 secret 扫描没有命中测试 API key。

## 后续扩展

- 在诊断报告中加入 RAG 快照清理摘要和快照数量，但不包含快照内容。
- 后续 SQLite/sqlite-vec 存储落地后，保持启动期清理合同不变，替换底层 store 即可。
- 增加启动期 RAG 快照恢复统计，用于判断是否需要后台重建索引。
