# PostgreSQL 大结果集游标分页

## 目标

本切片解决用户执行大范围只读 SQL 时，后端一次性把全部结果集装入内存并穿过 IPC 边界的问题。当前阶段不开发前端 UI，只完善 core-db、typed IPC、查询历史、结果导出、快照和真实 PostgreSQL 测试。

## 实现范围

- `PostgresDriver.execute()` 对单条只读 `SELECT` / `WITH` / `VALUES` 使用 PostgreSQL server-side cursor。
- 默认返回上限为 10000 行，调用方可以通过 `QueryRequest.limit` 指定，最大 clamp 到 100000。
- 游标路径使用 `BEGIN READ ONLY`、`DECLARE ... CURSOR`、`FETCH limit + 1`、`CLOSE`、`COMMIT`。
- 返回结果新增 `returnedRowCount`、`rowLimit`、`hasMore`、`truncated`。
- 多语句、写操作、DDL、需要确认的 SQL、rollback preview 不走游标分页，仍保持原事务保护路径。
- 查询历史、结果快照、JSON/Excel 导出同步保留截断元数据。
- `scripts/run-postgres-tests.mjs` 改为在测试文件所属 package 目录运行 Vitest，避免 Windows 下根目录转换超时。

## 边界

- 当前不提供“下一页 cursor token”。本切片目标是先保护内存和 IPC，而不是完整分页浏览协议。
- `rowCount` 在游标路径中代表本次 `FETCH limit + 1` 的探测行数，不代表数据库总行数。
- 如需精确总数，应由后续表格浏览或查询计划模块提供单独 count 策略，不能默认为任意 SQL 自动包一层 `count(*)`。
- 复杂 SQL AST 仍不在本轮引入；只根据现有语句拆分和安全分析决定是否可分页。

## 测试

已通过：

```bash
pnpm --filter @dbagent/shared typecheck
pnpm --filter @dbagent/shared test
pnpm --filter @dbagent/shared build
pnpm --filter @dbagent/core-db typecheck
pnpm --filter @dbagent/core-db lint
pnpm --filter @dbagent/core-db test
pnpm --filter @dbagent/core-db test:postgres
pnpm --filter @dbagent/core-db build
pnpm --filter @dbagent/desktop typecheck
pnpm --filter @dbagent/desktop test src/main/query-workflow.test.ts
```

真实 PostgreSQL 覆盖：

- `generate_series(1, 15005)` 大结果查询，`limit: 25`，验证只返回 25 行并设置 `hasMore/truncated`。
- query workflow 端到端真实 PostgreSQL 查询取消仍通过。
- auth PostgreSQL 集成测试仍通过。
- core-tools 业务 RAG/Agent 场景测试仍通过。
