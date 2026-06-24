# 2026-06-24 Agent SQL 确认来源切片

## 目标

上一切片已经要求写 SQL 必须带 `confirmed: true`，但模型也可以在 tool arguments 中生成该字段。本切片把确认来源从“模型参数”提升为“Agent 工具上下文中的 approval provenance”，避免模型伪造确认直接触发写入。

## 实现范围

- `core-agent`
  - 新增 `AgentToolApproval`，挂在 `AgentToolContext.approval` 上。
  - `PermissionManager.checkDetailed()` 返回 `{ decision, source }`，区分自动允许、缺少 approval provider、approval provider 批准/拒绝。
  - `ReactAgent` 只有在 approval provider 批准工具调用时，才把 approval provenance 传给工具 handler。
- `core-tools`
  - `execute_sql` 现在同时要求 `confirmed: true` 和 approval provenance。
  - 直接调用 handler 或模型只传 `confirmed: true` 时，仍返回 `SQL requires explicit confirmation`，不触达 driver。

## 用户级场景

- 用户在 ask 模式下批准一次写 SQL：Agent 将批准来源随工具上下文传给 `execute_sql`，工具层再调用 driver。
- 模型在没有用户批准的情况下生成 `{ confirmed: true }`：工具层拒绝执行。
- full-auto 模式自动允许 high 工具，但不会生成 approval provenance；需要确认的 SQL 仍被工具层拦截。

## 测试

- `permission-manager.test.ts`：验证 automatic allow 与 approval-provider allow 的 source 不同。
- `react-agent.test.ts`：验证 approval provider 批准后工具 handler 能看到 approval provenance。
- `db-tools.test.ts`：验证伪造 `confirmed: true` 不执行；带 approval provenance 才执行。
- `agent-rag-business-scenario.test.ts`：复验 Agent/RAG readonly 业务场景不受影响。

## 后续扩展

- 主进程正式 UI 接入时，approval provider 应由用户确认弹窗或安全策略生成，而不是由 renderer 或模型直接构造。
- 后续可以把 approval provenance 升级为一次性 approval token，包含 SQL hash、connection id、tool call id、过期时间和用户确认动作审计。
