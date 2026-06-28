# core-rag 快照恢复韧性模块

## 模块目标

本模块负责 Schema RAG 连接级快照的安全恢复。目标不是替代后续 SQLite/FTS/vector 持久化索引，而是在当前 JSON 快照阶段先保证三件事：

- 应用重启后可以恢复可用的内存索引。
- 快照损坏、版本不兼容或连接不匹配时，不影响数据库连接、SQL 执行和重新索引。
- 调用方可以拿到明确诊断状态，用于后续 UI、Agent 和诊断报告展示。

## 代码入口

- `packages/core-rag/src/schema-rag-snapshot-store.ts`
  - `save(index)`：使用临时文件加 rename 的方式写入连接级快照。
  - `load(connectionId)`：保持旧合同，返回 `SchemaRagIndex | undefined`，非损坏类 IO 错误仍向上抛。
  - `loadDetailed(connectionId)`：返回 `loaded | missing | invalid | error` 结构化结果。
  - 损坏快照会被重命名为 `.corrupt-{timestamp}`，避免每次启动重复读取坏文件。
- `packages/core-rag/src/progressive-schema-rag-indexer.ts`
  - `restore(connectionId)` 使用 `loadDetailed()`。
  - 快照缺失返回 `undefined`，表示 idle。
  - 快照损坏或读取失败返回 `failed` 状态，不抛出，避免阻塞主流程。

## 安全边界

- 快照按连接隔离，路径来自 `encodeURIComponent(connectionId)` 的安全文件名。
- 快照内 `connectionId` 必须与请求恢复的连接一致，否则视为无效并隔离。
- 快照内容必须通过 schema document、graph、glossary 的运行时校验。
- 损坏快照只影响 RAG 恢复，不影响数据库连接或重新构建索引。

## 开源借鉴与依赖判断

本切片没有引入新依赖。原因是当前目标是 JSON 快照恢复诊断，不涉及真实向量存储或全文检索。

借鉴方向：

- LlamaIndex/Haystack 等项目都将索引存储隔离在 storage adapter 后面，本切片延续这个边界，避免第三方 RAG 框架类型进入 DBAgent 公共合同。
- SQLite WAL、FTS5、sqlite-vec 仍是后续持久化索引候选，但需要单独完成 Electron 打包、Windows/macOS/Linux native 兼容、离线行为和许可评估。
- 当前用 Node.js 标准库实现原子替换和坏文件隔离，满足本阶段恢复需求，成本最低。

## 测试覆盖

- `packages/core-rag/test/schema-rag-snapshot-store.test.ts`
  - 真实文件系统快照读写。
  - 损坏 JSON、旧版本、连接不匹配快照降级。
  - `loadDetailed()` 返回诊断结果并隔离坏文件。
  - 删除单个连接快照不影响其他连接。
- `packages/core-rag/test/progressive-schema-rag-indexer.test.ts`
  - 渐进阶段状态。
  - 进程重启后的快照恢复。
  - 无快照时 idle。
  - 坏快照恢复返回 failed 状态且不污染 engine。

## 后续扩展

- 将 JSON 快照替换为 SQLite store，并启用 WAL。
- 增加快照大小、保存时间、document count 的诊断指标。
- 增加后台清理 `.corrupt-*` 文件的保留策略。
- 接入诊断报告，输出 RAG 快照恢复失败原因但不暴露敏感连接信息。
