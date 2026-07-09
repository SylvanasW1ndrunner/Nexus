# 2026-07-09 Agent Plan & Execute 持久化恢复切片

## 范围

本切片继续只开发后端 core 能力，不开发前端 UI，不开发多数据库。

完成内容：

- 新增 `AgentPlanExecutionStore`，用于保存 Plan & Execute 最新执行快照。
- `PlanExecuteAgent` 接入可选 `planStore`，在计划生成、步骤开始、步骤完成、失败、中止和完成时落盘。
- `AgentPlanExecuteOptions` 新增 `initialPlan`、`initialExecutedSteps`、`initialTotalIterations`，支持从已有计划继续执行。
- 新增 `AgentPlanExecutionSnapshot` 和状态类型。
- 快照读写复用 Agent 脱敏规则，避免 API key、连接串密码、工具结果敏感值进入恢复文件。
- 损坏快照文件降级为空，避免启动恢复被阻断。

## 验收结果

已通过：

- `tsc -p packages/core-agent/test/tsconfig.json --noEmit`
- `vitest run packages/core-agent/test/plan-execute-agent.test.ts packages/core-agent/test/plan-execute-store.test.ts --passWithNoTests`
- `tsc -p packages/core-agent/tsconfig.json --noEmit`
- `vitest run packages/core-agent/test --passWithNoTests`
- `eslint packages/core-agent/src packages/core-agent/test`
- 重建 `packages/core-agent/dist`
- `tsc -p packages/core-tools/tsconfig.json --noEmit`
- `vitest run packages/core-tools/test/agent-eval-suite-runner.test.ts packages/core-tools/test/agent-rag-business-scenario.test.ts --passWithNoTests`

结果：

- core-agent 全量 18 个测试文件、111 个用例通过。
- core-tools Agent/RAG 关键下游 12 个用例通过，4 个真实依赖/LLM 环境门控用例按条件跳过。

## 质量判断

该切片把 Plan & Execute 从一次性内存策略推进为可恢复后端能力：

- 计划进度可持久化。
- 应用重启后可以列出 `running` 计划。
- 调用方可以基于快照继续执行，不需要重新规划或重复已完成步骤。
- 工具权限、白名单、输出安全、上下文预算仍由 ReAct runner 统一处理。

## 后续工作

- 增加 `PlanExecuteRecoveryService`，输出面向主进程/最终 UI 的恢复计划摘要。
- 接入 headless agent service 或 skill runner。
- 将 Plan & Execute 纳入真实 SiliconFlow + 业务 PostgreSQL eval。
- 后续迁移到 SQLite WAL，解决高并发和大历史记录问题。
