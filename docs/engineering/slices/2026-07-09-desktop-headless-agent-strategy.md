# 2026-07-09 desktop Headless Agent 策略接线切片

## 范围

本切片只开发后端和 typed IPC 合同，不开发 renderer UI，不开发多数据库。

完成内容：

- `AgentRunRequest` 增加 `strategy`、`maxPlanSteps`、`stopOnStepFailure`。
- `AgentRunResponse` 增加实际 `strategy`、计划摘要、执行步数和总迭代数。
- `HeadlessAgentService` 支持 ReAct / Plan & Execute 两种策略。
- 服务层支持显式策略与轻量 auto 策略选择。
- `main.ts` 构造 `PlanExecuteAgent` 和 `AgentPlanExecutionStore`，Plan 快照写入用户数据目录。
- Plan & Execute 路径继续复用 ReAct step runner、工具白名单、权限、安全策略和审计日志。

## 用户场景

1. 用户发起普通日报查询：服务选择 ReAct，保持低延迟。
2. 用户显式要求 Plan & Execute：服务先生成 plan，再按 step 执行。
3. 用户发起复杂根因分析或预测任务：`auto` 策略自动升级为 Plan & Execute。
4. Skill 缺少必要工具：返回 `no_matching_skill`，不调用模型。
5. 模型尝试调用未授权工具：真实 handler 不执行，返回 permission denied。
6. 用户取消任务：runId 对应 AbortController 取消本轮调用。

## 验证结果

已运行：

- `tsc -p packages/shared/tsconfig.json --noEmit`
- `tsc -p packages/core-tools/tsconfig.json --noEmit`
- `tsc -p apps/desktop/tsconfig.json --noEmit`
- `eslint apps/desktop/src/main/agent-service.ts apps/desktop/src/main/agent-service.test.ts apps/desktop/src/main/main.ts packages/shared/src/ipc.ts`
- `vitest run apps/desktop/src/main/agent-service.test.ts apps/desktop/src/main/agent-tool-bootstrap.test.ts --passWithNoTests`
- `vitest run packages/core-tools/test/auto-skill-agent-runner.test.ts packages/core-tools/test/skill-agent-runner.test.ts --passWithNoTests`

说明：

- 为了让 desktop 类型检查读取最新 workspace 包类型，本轮顺序重建了 `packages/shared/dist` 和 `packages/core-tools/dist`。
- `pnpm --filter build` 在本机被 pnpm ignored-builds/install 校验拦截，改用 `node scripts/clean-path.mjs` + 直接 `tsc` 完成包构建。
- 没有新增第三方依赖。

## 后续工作

- 增加 Plan 恢复 IPC 和恢复服务。
- 增加真实 PostgreSQL + SiliconFlow 的 Plan & Execute eval。
- 后续如接入 LangGraph 等框架，应作为可替换 orchestrator adapter，不改变当前 shared IPC 合同。
