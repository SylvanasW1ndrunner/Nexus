# 2026-07-08 桌面连接删除接入 Schema RAG 清理

## 背景

上一切片已经在 `core-rag` 中提供快照清单和过期清理能力，但产品行为还没有真正接入桌面连接生命周期。用户删除数据库连接后，如果只删除连接配置和凭据，旧的 Schema RAG 快照和内存索引仍可能残留，后续 Agent 检索会看到已经删除的连接上下文。

本切片补齐桌面主进程组合层接线，不涉及 renderer UI。

## 实现内容

- `createConnectionWorkflow()` 增加可选 `schemaRag` 生命周期依赖：
  - `removeSnapshot(connectionId)`：删除持久化快照。
  - `clear(connectionId)`：清理内存索引。
- 删除连接流程调整为：
  1. 查找连接。
  2. 断开数据库 driver。
  3. 删除 Schema RAG 快照。
  4. 清理 Schema RAG 内存索引。
  5. 删除连接元数据。
  6. 删除凭据。
- `main.ts` 创建共享 `SchemaRagEngine`，同时注入 Agent 工具注册和连接 workflow。
- `main.ts` 创建 `SchemaRagSnapshotStore`，快照目录位于 Electron `userData/schema-rag-snapshots`。

## 恢复与失败语义

- RAG 清理失败时返回 `INTERNAL_ERROR`，保留连接元数据和凭据，避免用户凭据丢失且无法重试。
- 已删除的 RAG 快照可以通过重新连接和重新索引恢复，因此比凭据和连接配置优先级更低。
- 清理流程只处理当前连接 ID 对应的快照，不递归删除目录，不接收外部文件路径。

## 模块化与插件判断

本能力不适合做成官方插件。它是连接生命周期与 Schema RAG 基础设施之间的产品一致性接线，必须在主进程组合层稳定执行。

适合插件化的方向仍然是外围可替换能力：embedding provider、reranker、RAG eval、业务术语维护、数据库 catalog reader 和导出工具。这些能力后续可以通过官方插件接入，并通过权限 manifest 限制读取范围。

## 开源方案评估

本轮没有新增开源依赖。

- 当前需求是生命周期接线，不是检索算法或存储引擎替换。
- Node 原生文件能力和已有 `SchemaRagSnapshotStore` 已满足删除语义。
- 引入 LlamaIndex、LangChain、sqlite-vec 或 SQLite adapter 会扩大打包和迁移风险，不符合本切片目标。

## 测试

新增 `apps/desktop/src/main/connection-workflow.test.ts` 场景：

- 删除连接成功时，先删除 RAG 快照、再清理内存索引，最后删除连接元数据和凭据。
- RAG 快照删除失败时，返回 `INTERNAL_ERROR`，保留连接元数据和凭据，并且不会继续清理内存索引。

已运行：

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

结果：全部通过。提交前 secret 扫描没有命中测试 API key。

## 后续扩展

- 应用启动时读取 `ConnectionStore.list()`，调用 `SchemaRagSnapshotStore.cleanupInactive()` 清理无主快照。
- 将 RAG 快照清理结果接入诊断报告，便于定位磁盘占用和损坏快照。
- 后续进入 SQLite/sqlite-vec 存储时，保持连接级清理合同不变。
