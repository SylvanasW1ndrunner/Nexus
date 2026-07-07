# BetaV0.1.1 - PostgreSQL 查询取消运行时

## 背景

长 SQL 取消不能只停留在前端按钮或状态记录。远程数据库场景下，用户可能在本地桌面连接服务器 PostgreSQL，执行中的查询需要优先走 PostgreSQL backend cancel；如果拿不到 backend pid 或取消超时，再断开当前连接。

## 变更内容

- `IDatabaseDriver.execute()` 新增可选 `QueryExecutionObserver`，用于报告运行中查询的 PostgreSQL backend pid。
- `PostgresDriver.execute()` 改为通过 `pool.connect()` 获取 client，读取 backend pid 后回调 workflow。
- `QueryCancellationRegistry` 新增 `setBackendPid()`，把运行中 query id 和 backend pid 绑定。
- `PostgresDriver.cancel()` 支持：
  - `cancel-backend`：执行 `select pg_cancel_backend($1) as cancelled`。
  - `disconnect-connection`：调用当前连接的 `disconnect()` 作为 fallback。
- `PostgresDriver` 为每个连接维护独立取消池，避免业务查询池 `maxClients=1` 且长查询占用唯一连接时，取消请求被排队。
- `PostgresDriver.execute()` 在 `pg` client `processID` 不稳定时，会通过 `select pg_backend_pid()` 兜底捕获 backend pid。
- `createQueryCancellationWorkflow()` 在 cancel 决策后调用对应 driver，而不是只返回计划。
- PostgreSQL `57014 / canceling statement due to user request` 会被分类为 `QUERY_CANCELLED`，不再混同普通 SQL 失败。
- query workflow 会把 `QUERY_CANCELLED` 写入查询历史状态 `cancelled`，不再按 `failed` 保存。

## 开源评估

本切片继续使用现有 `pg` 驱动，不新增依赖。PostgreSQL 查询取消是数据库原生命令能力，新增第三方库没有必要，且会增加 Electron 打包、离线安装和维护风险。

## 测试覆盖

- registry 记录 backend pid 后，取消决策从 `disconnect-connection` 转为 `cancel-backend`。
- query workflow 接收 driver backend pid 回调并写入 registry。
- cancel workflow 在 backend pid 已知时调用 driver cancel。
- PostgresDriver 调用 `pg_cancel_backend($1)` 并返回结构化结果。
- PostgreSQL 用户取消错误分类为 `QUERY_CANCELLED`。
- core-db 全量测试通过，desktop main 全量测试通过。
- `apps/desktop/src/main/query-workflow.postgres.integration.test.ts` 使用真实 PostgreSQL 验证 `pg_sleep` 取消、`cancelled` 历史、取消后连接复用，以及 `maxClients=1` 下取消请求不被业务连接池阻塞。
- `pnpm test:postgres` 已接入桌面查询取消真实 PostgreSQL 集成测试。

## 已知限制

- `disconnect-connection` fallback 当前仍按保存连接 id 断开 driver pool；后续如需严格做到“只断开单个正在运行的物理连接”，需要在 driver 内进一步维护 `queryId -> client` 的强制销毁映射。
