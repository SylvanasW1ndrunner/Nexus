# 2026-07-07 PostgreSQL 查询取消端到端验收

## 背景

产品要求本地桌面连接远程 PostgreSQL 时，用户可以取消长 SQL。该能力不能只停留在 UI 状态或 registry 决策，必须在真实数据库上验证 `pg_cancel_backend` 能中断正在执行的查询，并且取消后连接仍可继续使用。

## 本轮变更

- `PostgresDriver` 为每个连接增加独立取消池，`max=1`，只执行 PostgreSQL backend cancel。
- `PostgresDriver.execute()` 捕获 backend pid 时保留 `client.processID` 快路径，并增加 `select pg_backend_pid()` 兜底，避免不同运行环境下驱动内部字段不稳定。
- `query-workflow` 将 `QUERY_CANCELLED` 写入查询历史状态 `cancelled`，区分用户取消和普通失败。
- `QueryHistoryItem.status` 增加 `cancelled`。
- `pnpm test:postgres` 增加 `apps/desktop/src/main/query-workflow.postgres.integration.test.ts`。
- `core-tools` 补齐测试直接依赖的 `@dbagent/core-llm` 和 `@dbagent/core-usage` workspace devDependencies，保证严格 pnpm 链接下 Agent/RAG 业务测试可解析依赖。

## 开源与依赖评估

本轮没有新增第三方运行依赖。查询取消直接复用 PostgreSQL 原生命令 `pg_cancel_backend(pid)` 和现有 `pg` 驱动能力。该方案与成熟数据库管理工具的基本思路一致：执行查询时记录 backend pid，取消时从独立连接发出 cancel 命令。

不引入额外库的原因：

- PostgreSQL cancel 是数据库原生命令，不需要额外 SDK。
- Electron 桌面包需要控制依赖体积、native 构建和离线安装风险。
- 取消逻辑需要和 DBAgent 自己的 query id、历史、权限和 fallback 决策绑定，通用库无法直接覆盖产品语义。

## 验收场景

真实 PostgreSQL 集成测试覆盖：

- 启动 `select pg_sleep(30)`。
- 在查询完成前捕获 backend pid。
- 通过 `db:cancel-query` 等价 workflow 调用 `pg_cancel_backend`。
- 原查询返回 `QUERY_CANCELLED`。
- 查询历史写入 `status: cancelled`。
- 本地用量不计入成功查询。
- 取消后同一保存连接仍可执行 `select 1`。
- 业务连接池 `maxClients=1` 时，取消请求仍通过独立取消池执行，不排队等待长查询释放业务连接。

## 测试结果

- `turbo typecheck`：通过，21 个任务成功。
- `turbo lint`：通过，11 个任务成功。
- `turbo test --concurrency=1`：通过，21 个任务成功。
- `node scripts/smoke.mjs`：通过。
- `node scripts/run-postgres-tests.mjs`：通过，包含 core-db、desktop query cancel、core-auth、core-tools Agent/RAG 真实 PostgreSQL 测试。
- secret scan：未发现 SiliconFlow/OpenAI 风格测试密钥进入仓库文件。

## 已知风险

- `disconnect-connection` fallback 仍按保存连接 id 断开 driver pool。它能作为兜底释放用户路径，但还不是精确的 `queryId -> physical client` 强制销毁。后续如果要保证不影响同一保存连接下其他 tab，需要在 driver 层维护运行中 query 到 client 的映射。
- 本轮没有运行真实 LLM live test；该门禁仍由 `pnpm test:agent-rag-live` 显式开启，并要求本机环境变量注入 SiliconFlow 测试 key。
