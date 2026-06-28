# 2026-06-28 RAG 快照恢复韧性切片

## 背景

当前开发路径是先完成后端能力，再统一重建前端。Schema RAG 是 Agent 能正确理解数据库结构的基础能力，恢复路径必须可靠。此前快照损坏时 `load()` 会静默返回 `undefined`，虽然不会阻塞使用，但调用方无法区分“没有快照”和“快照坏了”，也会在后续启动中反复读取同一个坏文件。

## 本次实现

- 新增 `SchemaRagSnapshotStore.loadDetailed(connectionId)`。
- 快照加载结果结构化为：
  - `loaded`：恢复成功。
  - `missing`：该连接没有快照。
  - `invalid`：快照格式、版本、连接 ID 或内容校验失败。
  - `error`：非内容损坏类 IO 错误。
- 对 `invalid` 快照执行隔离重命名，后缀为 `.corrupt-{timestamp}`。
- 保留旧 `load()` 合同，避免破坏已有调用方。
- `ProgressiveSchemaRagIndexer.restore()` 接入诊断结果，恢复失败时返回 `failed` 状态而不是抛出。

## 不做的事

- 不引入 SQLite/FTS/vector 依赖。
- 不实现真实后台渐进索引队列。
- 不把 RAG 恢复状态接入 UI，因为当前 UI 冻结。
- 不上传、同步或共享本地 RAG 快照。

## 测试

已新增和更新测试：

- `schema-rag-snapshot-store.test.ts`
  - 快照 round-trip。
  - 缺失/损坏/旧版本快照降级。
  - 连接不匹配快照诊断与隔离。
  - 单连接删除隔离。
- `progressive-schema-rag-indexer.test.ts`
  - 重启恢复。
  - idle 状态。
  - 坏快照恢复失败状态。

本切片使用真实临时文件目录测试，不使用 mock 文件系统。

## 质量结论

本切片属于 core 包内部增强，不改变 Agent、DB、renderer 或 IPC 合同。损坏 RAG 快照现在可观测、可隔离、可恢复，不会阻塞数据库主流程。
