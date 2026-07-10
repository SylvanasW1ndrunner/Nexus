# core-db：查询历史与结果快照

## 模块职责

查询历史和结果快照属于传统数据库 IDE 的基本盘能力，用于支持：

- SQL 历史面板；
- 查询失败后的复查；
- Agent 读取历史上下文；
- 查询结果“钉住”并在重启后恢复；
- 后续导出、审计和报告生成。

当前实现仍保持本地优先，不依赖最终前端 UI，也不依赖云端服务。

## 查询历史

实现入口：

- `packages/core-db/src/query-history.ts`
- `apps/desktop/src/main/query-workflow.ts`
- `packages/core-tools/src/db-tools.ts`

`QueryHistoryStore` 写入 `userData/data/query-history.json`，使用 JSON 原子写入。查询执行 workflow 会在成功、失败、阻断、取消时写入历史，记录：

- connectionId；
- SQL；
- status；
- rowCount / returnedRowCount / rowLimit / hasMore / truncated；
- elapsedMs；
- errorMessage；
- safety；
- transaction；
- createdAt。

读取合同：

- `list(options)`：返回 `QueryHistoryItem[]`，兼容现有 IPC。
- `search(options)`：返回 `{ items, total, offset, limit }`，供后续历史面板使用。

Agent 工具：

- `read_query_history`
- 风险等级：`safe`
- readonly：`true`
- 来源：`official.database-postgres`

该工具只读取本地历史，不执行 SQL，不读取数据库凭证。

## 结果快照

实现入口：

- `packages/core-db/src/query-snapshot.ts`
- `packages/shared/src/ipc.ts`
- `apps/desktop/src/main/main.ts`

`QuerySnapshotStore` 写入 `userData/data/query-snapshots.json`，用于保存用户钉住的查询结果。公共类型已经提升到 `@dbagent/shared`：

- `QuerySnapshot`
- `QuerySnapshotSummary`
- `CreateQuerySnapshotRequest`
- `ListQuerySnapshotsRequest`
- `QuerySnapshotRequest`
- `DeleteQuerySnapshotResponse`

主进程 IPC：

- `db:create-query-snapshot`
- `db:list-query-snapshots`
- `db:get-query-snapshot`
- `db:delete-query-snapshot`

快照保存 SQL、连接、列信息、行数据、耗时、安全报告、标签、备注和来源历史 ID。列表接口只返回 `previewRows`，完整内容必须通过 `get(id)` 读取，避免后续 UI 或 Agent 一次性搬运大结果集。

## 数据安全

- 历史和快照都只存本机。
- 不保存数据库密码、API key 或 OS keychain 内容。
- 快照会规范化 `bigint`、`Date`、`Buffer`、非有限数字、JSONB 和数组，避免真实 PostgreSQL 结果无法 JSON 序列化。
- 文件损坏时按空列表降级，避免单个本地状态文件阻塞数据库使用。

## 当前限制

- 仍使用 JSON 文件，适合 BetaV0.1.1 阶段。
- 大规模历史、快照检索和全文搜索后续应迁移到 SQLite。
- `db:delete-query-snapshot` 是删除本地快照记录，不影响数据库，也不提供回收站。

## 测试入口

- `packages/core-db/test/query-history.test.ts`
- `packages/core-db/test/query-snapshot.test.ts`
- `packages/shared/test/ipc-contract.test.ts`
- `packages/core-tools/test/db-tools.test.ts`
- `apps/desktop/src/main/agent-tool-bootstrap.test.ts`
