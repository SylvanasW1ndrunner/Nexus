# 2026-07-09 desktop Agent Plan 恢复官方工具

## 开发范围

本切片完成 Plan & Execute 恢复数据的官方工具化。目标是在前端 UI 冻结阶段，让后端 Agent 能读取可恢复计划、查看计划执行摘要、检查失败工具调用证据，并通过官方插件权限体系管理这些工具。

## 代码变更

- `apps/desktop/src/main/agent-tool-bootstrap.ts`
  - 新增 `list_recoverable_agent_plans`、`list_agent_plan_executions`、`read_agent_plan_execution`。
  - 工具只依赖 plan store 和 recovery service 的只读接口。
  - 工具详情返回做 final text、tool executions、session messages 截断。
- `apps/desktop/src/main/main.ts`
  - 将 `AgentPlanExecutionStore` 和 `PlanExecuteRecoveryService` 提前创建。
  - 将 plan store/recovery service 注入 `registerDesktopAgentTools()`。
- `packages/core-tools/src/official-plugin-registry.ts`
  - 新增 `agent.plan` resource scope。
  - 新增 `official.agent-plan-recovery` manifest。
  - 新增 `agent.plan.read` 权限和 3 个静态工具贡献。
- `apps/desktop/src/main/agent-tool-bootstrap.test.ts`
  - 增加真实临时文件 plan snapshot 测试。
  - 覆盖恢复列表、按 session 列表、详情截断、权限解析。
- `packages/core-tools/test/official-plugin-registry.test.ts`
  - 更新默认官方插件和静态工具贡献预期。

## 质量门禁

已执行：

- `tsc -p apps/desktop/tsconfig.json --noEmit`
- `tsc -p packages/core-tools/tsconfig.json --noEmit`
- `tsc -p packages/core-tools/tsconfig.json`
- `vitest run apps/desktop/src/main/agent-tool-bootstrap.test.ts packages/core-tools/test/official-plugin-registry.test.ts --passWithNoTests`
- `eslint` touched TS files

## 决策记录

- 本切片只开放只读工具，不开放恢复写动作。
- 恢复动作保留给桌面服务和未来 UI，便于用户确认和审计。
- 没有引入第三方 workflow/tracing 依赖，继续复用现有 `ToolRegistry` 和官方插件 registry。

## 下一步

- 将 Agent checkpoint 级 ReAct 恢复记录也纳入官方只读工具。
- 为 plan/session/stream 三类历史工具增加统一 token-aware 裁剪策略。
- 后续前端重建时，可直接基于这些工具或对应 IPC 服务实现恢复面板。
