# BetaV0.1.1 Agent SQL 确认来源

## 范围

本切片继续强化 Agent 数据库写入安全，修复“模型可在 tool arguments 中伪造 `confirmed: true`”的设计缺口。

## 变更

- `AgentToolContext` 新增 approval provenance。
- `PermissionManager` 新增 `checkDetailed()`，保留原 `check()` 兼容旧调用。
- `ReactAgent` 只在 approval provider 批准后向工具 handler 传入 approval provenance。
- `execute_sql` 同时校验 `confirmed: true` 和 `approval.toolName === 'execute_sql'`，否则拒绝执行。

## 验证记录

- `tsc -p packages/core-agent/tsconfig.json --noEmit`
- `tsc -p packages/core-tools/tsconfig.json --noEmit`
- `vitest run packages/core-agent/test/permission-manager.test.ts packages/core-agent/test/react-agent.test.ts packages/core-tools/test/db-tools.test.ts packages/core-tools/test/agent-rag-business-scenario.test.ts`：4 个测试文件通过，37 个用例通过，2 个 live/PG 门控用例按默认配置跳过。
- `vitest run packages/core-agent/test packages/core-tools/test --passWithNoTests`：22 个测试文件通过，130 个用例通过，2 个 live/PG 门控用例按默认配置跳过。
- `eslint packages/core-agent/src/types.ts packages/core-agent/src/permission-manager.ts packages/core-agent/src/react-agent.ts packages/core-tools/src/db-tools.ts`：通过。

## 已知边界

- approval provenance 当前是内存上下文，不是加密 token；足以解决模型参数伪造，但还不是最终 UI/主进程用户确认协议。
- 后续主进程接入时应生成一次性 approval token，并绑定 SQL hash、connection id、tool call id 和过期时间。
