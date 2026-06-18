# BetaV0.1.1 - SQL 执行前预审计划

## 新增能力

本次在 `packages/core-db` 增加 `buildSqlExecutionPlan()`，用于在执行 SQL 前生成统一审查计划。

计划包含：

- 执行决策：`execute`、`requires-confirmation`、`blocked`。
- 安全报告：复用 `analyzeSqlSafety()`。
- 事务策略：`none`、`recommended`、`required`、`unavailable`。
- 是否具备回滚保护。
- 是否建议先运行 EXPLAIN。
- 确认理由和执行说明，供 Agent、IPC service 和未来 UI 复用。

## 安全增强

- `UPDATE` 无 `WHERE` 标记为 `dangerous`。
- `DELETE` 无 `WHERE` 标记为 `dangerous`。
- 只读连接上的写操作仍在到达数据库前阻断。
- 多语句写操作在支持事务时要求事务执行；不支持事务时明确标记 rollback unavailable。

## 用户价值

用户或 Agent 在运行 SQL 前可以得到统一的、可解释的审查结果：

- 哪些 SQL 可以直接运行。
- 哪些 SQL 需要用户确认。
- 哪些 SQL 被只读策略阻断。
- 哪些 SQL 应先看 EXPLAIN。
- 写操作是否有失败回滚保护。

## 影响范围

- 新增 `packages/core-db/src/sql-execution-plan.ts`。
- 扩展 `packages/core-db/src/index.ts` 导出。
- 增强 `packages/core-db/src/sql-safety.ts` 的无 WHERE 更新/删除识别。
- 新增 `packages/core-db/test/sql-execution-plan.test.ts`。
- 扩展 `packages/core-db/test/sql-safety.test.ts`。

## 验证

```powershell
C:\Users\cdnzx\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe node_modules\typescript\bin\tsc -p packages\core-db\tsconfig.json --noEmit
C:\Users\cdnzx\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe node_modules\vitest\vitest.mjs run packages\core-db\test\sql-safety.test.ts packages\core-db\test\sql-execution-plan.test.ts
```

## 已知限制

- 当前是静态预审，不替代 PostgreSQL `EXPLAIN` 或真实权限检查。
- 当前不解析 SQL AST；复杂嵌套语句的危险识别后续可接入成熟 SQL parser，并按开源优先规则评估依赖。
