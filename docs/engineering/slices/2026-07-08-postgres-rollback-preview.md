# 2026-07-08 PostgreSQL 事务试运行与回滚预览

## 背景

数据工程师在生产或远程 PostgreSQL 上验证写入 SQL 时，需要一种“真实执行语义、但不提交结果”的预览能力。普通 SQL 安全检查只能判断风险，无法证明 DML、DDL 或多语句批处理在数据库里实际会影响什么；直接提交又不符合正式 IDE 的安全边界。本切片把回滚预览下沉到 `core-db`，作为 SQL 执行链路的后端能力，不依赖最终 UI。

## 变更内容

- `QueryRequest` 新增 `transactionMode?: 'auto' | 'rollback'`；旧的 `dryRun: true` 兼容映射为 `transactionMode: 'rollback'`。
- `QueryExecutionResult` 和 `QueryHistoryItem` 新增 `transaction` 元数据，记录是否开启事务、是否提交、是否回滚、是否 rollback-only。
- `PostgresDriver.execute()` 支持 rollback-only 执行路径：`BEGIN -> 执行 SQL -> ROLLBACK`，并返回真实查询结果和事务报告。
- 需要确认的写操作继续要求 `confirmed: true`，回滚预览不会绕过确认门禁。
- 参数化多语句 SQL 被拒绝，避免 `$1` 等参数在批处理语义下产生不可预期绑定。
- 回滚预览拒绝 PostgreSQL 不允许在显式事务中执行的语句，例如 `VACUUM`、`CREATE/DROP DATABASE`、`ALTER SYSTEM`、`CREATE/DROP TABLESPACE`、`CREATE/DROP INDEX CONCURRENTLY`。
- `analyzeSqlSafety()` 改为检查每一条拆分后的语句，修复只读连接中 `select ...; update ...` 只看第一句的安全漏洞。
- 查询历史和 JSON 导出保留事务元数据，方便后续审计、Agent 工具证据和结果快照复查。
- `apps/desktop/src/main/query-workflow.ts` 透传执行结果中的事务元数据到查询历史。

## 开源与依赖评估

本切片不新增第三方依赖。原因：

- 当前目标是事务执行策略和安全门禁，不是完整 SQL AST 分析。
- 现有 `splitSqlStatements()` 已能处理字符串、注释、嵌套块注释和 dollar quote 中的分号，足以支撑本轮“多语句边界”和“只读连接逐语句检查”。
- 引入 `libpg_query` / `pgsql-parser` 会带来 native/parser 打包评估；引入 `node-sql-parser` 可用于未来 AST 风险识别，但本轮还不需要 affected table、列级权限或 SQL 改写。

后续如果要实现 affected rows 预估、SQL 自动改写、列级权限判断或跨方言 AST，需要重新评估成熟 parser，并隔离在 adapter 后面。

## 验收场景

- 读查询默认不返回事务元数据。
- 确认后的写 SQL 使用自动事务并返回 `committed: true`。
- `transactionMode: 'rollback'` 在真实 PostgreSQL 上执行复杂多语句写入后回滚，测试验证临时表不存在、数据不落库。
- `dryRun: true` 兼容回滚预览；`dryRun: true` 和 `transactionMode: 'auto'` 冲突时返回验证错误。
- 只读连接中第一句为 SELECT、后续为 UPDATE 的批处理必须在 workflow/driver 前被拦截。
- 回滚预览中的 `VACUUM` 和并发索引等不支持事务语句返回 `UNSUPPORTED_OPERATION`。
- 多语句参数化批处理返回 `UNSUPPORTED_OPERATION`。
- 查询历史与 JSON 导出包含事务审计元数据。

## 测试结果

- `pnpm --filter @dbagent/shared typecheck`：通过。
- `pnpm --filter @dbagent/shared test`：通过，18 个测试。
- `pnpm --filter @dbagent/shared build`：通过。
- `pnpm --filter @dbagent/core-db typecheck`：通过。
- `pnpm --filter @dbagent/core-db lint`：通过。
- `pnpm --filter @dbagent/core-db test`：通过，160 个测试通过，5 个 PostgreSQL 集成测试在普通单测入口跳过。
- `pnpm --filter @dbagent/core-db build`：通过。
- `pnpm --filter @dbagent/core-db test:postgres`：通过，包含真实 PostgreSQL 的 core-db、desktop query workflow、core-auth、core-tools Agent/RAG 场景。
- `pnpm --filter @dbagent/desktop typecheck`：通过。
- `pnpm --filter @dbagent/desktop test src/main/query-workflow.test.ts`：通过，11 个测试。

## 已知限制

- 当前回滚预览不做 affected table 精确解析，安全判断仍是语句级规则。
- rollback-only 模式适合试运行 DML 和可事务化 DDL；PostgreSQL 原生不支持事务内执行的语句会被拒绝。
- 参数化多语句暂不支持；后续如需支持，需要明确每条语句的参数绑定语义和审计展示方式。
