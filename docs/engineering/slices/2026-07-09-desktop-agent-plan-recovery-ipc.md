# 2026-07-09 desktop Agent Plan & Execute 恢复 IPC

## 范围

本切片完成 desktop 主进程的 Plan & Execute 恢复入口，不开发 renderer UI。

改动包括：

- 在 shared typed IPC 中新增 `agent:recoverable-plans`、`agent:continue-plan`、`agent:abandon-plan`。
- 在 `HeadlessAgentService` 增加可恢复计划列表、继续执行、放弃计划方法。
- 在 Electron 主进程中复用同一个 `AgentPlanExecutionStore`，并注入 `PlanExecuteRecoveryService`。
- 增加 desktop 服务级测试，使用真实临时文件存储验证恢复生命周期。

## 设计决策

恢复执行按当前请求重新计算工具权限。这样即使历史任务来自更宽松的模式，用户切换到 readonly 后恢复也不会得到写工具。测试中注册了一个高危写工具，但不把它暴露给当前运行，验证模型调用该工具时会被拒绝。

## 验收结果

- `apps/desktop/src/main/agent-service.test.ts` 覆盖 12 个服务测试，其中 4 个是本切片新增恢复场景。
- `packages/shared` 类型检查通过。
- `apps/desktop` 类型检查通过。
- 指定文件 ESLint 通过。

## 后续

- 为 `restart` 增加明确 IPC 行为：基于原始 goal 重新规划，但保留旧 plan 作为上下文。
- 将恢复入口接入最终 UI 的 Agent 历史/恢复面板。
- 在 live Agent/RAG eval 中增加一次真实 provider 的中断恢复用例。
