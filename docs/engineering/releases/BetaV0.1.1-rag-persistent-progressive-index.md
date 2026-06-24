# BetaV0.1.1 RAG 持久化快照与渐进索引状态

## 背景

当前阶段按“先完成核心功能，最后统一重建前端 UI”的路径推进。本轮切片聚焦 `core-rag`，让 Schema RAG 具备连接级落盘恢复能力，并为后续大 schema 渐进索引提供稳定状态合同。

## 代码变更

- 新增 `SchemaRagSnapshotStore`：
  - 使用真实文件系统保存连接级 JSON v1 快照。
  - 保存 documents、glossary、graph edge records、`indexedAt` 和 `connectionId`。
  - 写入采用临时文件加 rename，避免半写入覆盖完整快照。
  - 缺失、损坏或旧版本快照返回 `undefined`，不阻断数据库连接和基础 SQL 能力。
- 新增 `ProgressiveSchemaRagIndexer`：
  - 提供 `skeleton -> hot_tables -> long_tail -> ready` 状态模型。
  - 当前仍一次性构建完整内存索引，后续阶段可以替换为真实分批抽取、暂停、恢复、取消和 on-demand 单表索引。
  - 支持索引完成后保存快照，以及应用重启后从快照恢复到新的 `SchemaRagEngine`。
- 扩展 `SchemaRagEngine`：
  - `loadIndex(index)`：加载已持久化并反序列化的索引。
  - `getIndexStatus(connectionId)`：返回 `idle` 或 `ready` 状态，避免重载 `hasIndex()` 语义。

## 开源借鉴与依赖决策

本轮没有新增运行时依赖。调研结论如下：

- [LlamaIndex.TS Storage](https://developers.llamaindex.ai/typescript/framework/modules/data/stores/) 的持久化设计强调 storage context 与 index/retriever 分层。我们借鉴该分层思想，但没有引入框架，避免让 DBAgent 的 schema 合同被通用 RAG 框架绑定。
- [SQLite FTS5](https://www.sqlite.org/fts5.html) 是后续本地全文检索候选，适合替换当前轻量 token 检索；但本轮尚未建立 SQLite storage adapter，也未完成 Electron native 打包评估。
- [sqlite-vec](https://alexgarcia.xyz/sqlite-vec/) 是后续本地向量检索候选，可作为 vector adapter 接入；当前版本仍处于 alpha/文档进行中状态，因此不进入 BetaV0.1.1 发布依赖。

## 插件化判断

持久化快照和渐进索引状态机不作为官方插件。它们是 `core-rag` 基础设施，和连接生命周期、恢复、Agent schema context 强绑定。

适合官方插件化的能力包括：

- RAG eval 数据集与报告。
- embedding provider adapter。
- reranker adapter。
- ER 图导出。
- 业务术语维护与导入工具。

## 测试

已新增并通过：

- `packages/core-rag/test/schema-rag-snapshot-store.test.ts`
  - 真实临时目录读写。
  - 保存、读取、graph/glossary round-trip。
  - 新 engine 恢复后继续检索。
  - 缺失、损坏、旧版本快照降级为 `undefined`。
  - 按连接删除快照，不误删其他连接。
- `packages/core-rag/test/progressive-schema-rag-indexer.test.ts`
  - 渐进阶段状态断言。
  - 快照落盘。
  - 模拟进程重启恢复并继续 search/buildContext。
  - 无快照时保持 idle 状态。

验证命令：

```powershell
$env:PATH='C:\Users\cdnzx\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin;' + $env:PATH
.\node_modules\.bin\vitest.CMD run packages/core-rag/test/schema-rag-snapshot-store.test.ts packages/core-rag/test/progressive-schema-rag-indexer.test.ts packages/core-rag/test/schema-rag-engine.test.ts packages/core-rag/test/retrieval-evaluation.test.ts
.\node_modules\.bin\tsc.CMD -p packages/core-rag/tsconfig.json --noEmit
```

结果：

- `core-rag` 相关 4 个测试文件通过，23 个 case 通过。
- `packages/core-rag` TypeScript 检查通过。

## 未运行项

- 未运行 `pnpm test:postgres`：本轮没有触碰 PostgreSQL catalog extractor、SQL 执行或 Agent tool-calling 合同。下一轮把真实 `TableDetail[]` 抽取接入快照时必须纳入。
- 未运行 live LLM：本轮没有修改 SiliconFlow provider、Agent tool 选择、prompt 或 tool-calling 输出结构。
- `pnpm --filter @dbagent/core-rag test` 被 pnpm 的 build-script approval 流程中断；已改用当前 `node_modules/.bin` 的 `vitest` 和 `tsc` 做直接验证。

## 后续工作

- 把 `core-db` 的真实 PostgreSQL catalog 抽取结果接入 `ProgressiveSchemaRagIndexer`。
- 引入 schema revision/manifest，支持 schema 变化后的增量更新和旧文档清理。
- 增加取消、失败恢复、并发索引保护和 on-demand 单表索引。
- 完成 SQLite FTS5/sqlite-vec adapter 的依赖、许可证、打包和性能评估后，再决定是否引入。
