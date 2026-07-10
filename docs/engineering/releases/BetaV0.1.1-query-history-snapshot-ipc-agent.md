# BetaV0.1.1：查询历史与结果快照后端接线

## 新增能力

- 新增结果快照 IPC：
  - `db:create-query-snapshot`
  - `db:list-query-snapshots`
  - `db:get-query-snapshot`
  - `db:delete-query-snapshot`
- Agent 新增只读工具 `read_query_history`，用于读取本地 SQL 执行历史。
- 官方插件 `official.database-postgres` 增加 `sql-history` capability。
- 桌面主进程将 `queryHistoryStore` 接入 headless Agent 工具注册。

## 安全边界

- `read_query_history` 不执行 SQL。
- 结果快照只存本机 JSON 文件。
- 快照不包含数据库凭证或 API key。
- 损坏的历史/快照文件按空列表降级，不阻塞数据库使用。

## 测试结果

- 共享 IPC 合同测试通过。
- core-db 快照持久化测试通过。
- core-tools 数据库工具测试通过。
- 官方插件清单测试通过。
- desktop Agent 工具注册测试通过。

## 当前限制

- 历史和快照仍是 JSON 文件，后续大规模使用应迁移到 SQLite。
- 快照删除不提供回收站。
