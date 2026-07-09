# 2026-07-09 Agent Plan & Execute 切片

## 范围

本切片继续只开发后端 core 能力，不开发前端 UI，不开发多数据库。

完成内容：

- 新增 `PlanExecuteAgent`，支持先规划、再逐步复用 ReAct runner 执行。
- `AgentStrategy` 扩展为 `react | plan-execute`。
- 新增 `AgentPlan`、`AgentPlanStep`、`AgentPlanExecuteOptions`、`AgentPlanExecuteResult` 等类型。
- 规划输出支持 JSON 和 fenced JSON。
- 规划非法时返回 `planning_failed`，不会执行任何步骤。
- 步骤失败时默认停止，并把后续步骤标记为 `skipped`。
- 聚合每个步骤的 iteration、工具执行记录和上下文压缩报告。

## 验收结果

已通过：

- `tsc -p packages/core-agent/test/tsconfig.json --noEmit`
- `vitest run packages/core-agent/test/plan-execute-agent.test.ts --passWithNoTests`
- `tsc -p packages/core-agent/tsconfig.json --noEmit`
- `vitest run packages/core-agent/test --passWithNoTests`
- `eslint packages/core-agent/src packages/core-agent/test`
- `tsc -p packages/core-tools/tsconfig.json --noEmit`
- `vitest run packages/core-tools/test/agent-eval-suite-runner.test.ts packages/core-tools/test/agent-rag-business-scenario.test.ts --passWithNoTests`

说明：

- 已重建 `packages/core-agent/dist`。
- 本切片没有新增第三方依赖。
- 本切片没有修改 PostgreSQL、RAG 索引、Python、终端、桌面 UI 或 Electron 打包配置。
- `core-tools` 首次类型检查曾因与 `core-agent/dist` 清理重建并行发生解析竞态失败；在 `core-agent` build 完成后顺序重跑通过。

## 质量判断

本轮完成的是 Plan & Execute 的稳定后端骨架，不是最终完整 Agent 工作流。它已经具备可被上层服务和后续 UI 接线的核心合同：

- 计划可结构化展示。
- 步骤执行可复用现有权限和工具安全边界。
- 失败路径可观测且不会继续误执行后续步骤。
- 下游 Agent/RAG eval runner 未被破坏。

## 后续工作

- 将 Plan & Execute 接入 headless agent service 或官方 Agent runner。
- 增加 plan checkpoint 持久化和恢复。
- 增加真实 SiliconFlow + 业务 PostgreSQL 场景的 Plan & Execute eval。
- 后续如果需要并行步骤或 DAG，可以在当前类型上扩展，而不是重写 ReAct 主循环。
