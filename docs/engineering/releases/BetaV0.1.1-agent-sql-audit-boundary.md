# BetaV0.1.1 Agent SQL 预审与权限边界

## 范围

本次版本切片强化 Agent 调用数据库时的安全边界，属于后端能力开发，不涉及正式前端 UI。

## 变更

- 新增 Agent 只读工具 `audit_sql`，用于在执行前获取 `QuerySafetyReport`。
- `query_database` 现在只接受单条只读 SQL，即使连接本身可写也不会执行写操作。
- `execute_sql` 在工具层增加确认门禁，未确认的写 SQL 不触达 driver。
- `PostgresDriver.execute()` 对所有需要确认但未确认的 SQL 返回 `CONFIRMATION_REQUIRED`，作为最后一道硬门禁。
- `analyzeSqlSafety()` 对 writable CTE、`EXPLAIN ANALYZE` 包裹写操作、COPY/DO/GRANT/REVOKE/VACUUM 等管理语句和未知语句采取更保守的确认策略。

## 测试

已覆盖：

- SQL 安全矩阵：只读、写入、DDL、多语句、writable CTE、`EXPLAIN ANALYZE` 写操作、管理类语句、未知语句。
- Driver 门禁：未确认写 SQL 返回 `CONFIRMATION_REQUIRED`，不触达 PostgreSQL pool。
- Agent DB 工具：`audit_sql` 返回预审结果，`query_database` 拒绝写 SQL，`execute_sql` 未确认时不调用 driver。
- 真实 PostgreSQL integration 中的写入用例已显式传入确认标记，保持事务和回滚测试语义清晰。

本轮验证记录：

- `tsc -p packages/core-db/tsconfig.json --noEmit`
- `tsc -p packages/core-tools/tsconfig.json --noEmit`
- `tsc -p packages/core-agent/tsconfig.json --noEmit`
- `vitest run packages/core-db/test/sql-safety.test.ts packages/core-db/test/postgres-driver-runtime-errors.test.ts packages/core-tools/test/db-tools.test.ts packages/core-agent/test/permission-manager.test.ts packages/core-agent/test/react-agent.test.ts`：5 个测试文件通过，50 个用例通过。
- `node scripts/run-postgres-tests.mjs`：真实 PostgreSQL 门控通过，包含 core-db、core-auth 和 core-tools business fixture。
- `vitest run packages/core-db/test packages/core-tools/test packages/core-agent/test --passWithNoTests`：44 个测试文件通过、1 个 PostgreSQL 门控文件默认跳过；277 个用例通过、5 个门控用例跳过。
- `eslint packages/core-db/src/postgres-driver.ts packages/core-db/src/sql-safety.ts packages/core-tools/src/db-tools.ts`：生产改动文件通过。
- `git diff --check`：通过。

已知门禁现状：对 `packages/core-db packages/core-tools packages/core-agent` 运行全量 ESLint 时仍存在历史 lint 债，主要集中在旧测试替身类的 `require-await`、旧模块的 type-only import 和 unsafe assignment。本切片未扩大范围清理这些无关问题。

## 开源评估

本切片评估了 [`node-sql-parser`](https://github.com/taozhi8833998/node-sql-parser)、[`SQLGlot`](https://github.com/tobymao/sqlglot)、[`libpg_query`](https://github.com/pganalyze/libpg_query) 和 [`pgsql-parser`](https://github.com/launchql/pgsql-parser)。当前暂不新增 parser 依赖，原因是本轮目标是执行安全门禁，而不是 AST 级 SQL 语义分析；后续如进入 affected table、SQL 血缘、自动改写、跨方言 parser，将以 adapter 方式隔离依赖。

## 已知边界

- 当前安全预审仍是保守文本规则，不承诺完整 SQL AST 解析。
- 用户确认来源已在后续安全切片中升级为 approval provenance；历史记录保留该风险是为了说明本切片的原始边界。
- 真实 PostgreSQL readonly role、planner estimated rows 和函数副作用识别需要后续专项测试补齐。
