# 2026-07-09 Agent Plan & Execute 恢复服务切片

## 范围

本切片继续只开发后端 core 能力，不开发前端 UI，不开发多数据库。

完成内容：

- 新增 `packages/core-agent/src/plan-execute-recovery.ts`。
- 新增 `AgentPlanRecoveryService`，并导出 `PlanExecuteRecoveryService` 别名。
- 支持列出可恢复 Plan & Execute 任务。
- 支持把可恢复快照续跑为 `PlanExecuteAgent.run()` 参数。
- 支持 abandon running 快照。
- 非完成续跑结果和 runner 异常不会覆盖原 running 快照。
- recovery summary 和 resume prompt 复用 store 脱敏结果，避免 secret 泄露。

## 验收结果

已通过：

- `tsc -p packages/core-agent/test/tsconfig.json --noEmit`
- `vitest run packages/core-agent/test/plan-execute-recovery.test.ts --passWithNoTests`
- `tsc -p packages/core-agent/tsconfig.json --noEmit`
- `vitest run packages/core-agent/test --passWithNoTests`
- `eslint packages/core-agent/src packages/core-agent/test`
- 重建 `packages/core-agent/dist`
- `tsc -p packages/core-tools/tsconfig.json --noEmit`
- `vitest run packages/core-tools/test/agent-eval-suite-runner.test.ts packages/core-tools/test/agent-rag-business-scenario.test.ts --passWithNoTests`

结果：

- core-agent 全量 19 个测试文件、120 个用例通过。
- core-tools Agent/RAG 关键下游 12 个用例通过，4 个真实依赖/LLM 环境门控用例按条件跳过。

## 质量判断

该切片让 Plan & Execute 具备完整的 core 层恢复服务合同：

- 启动扫描可以列出 recoverable plan。
- 用户继续恢复时服务能注入 plan/session/progress。
- 完成续跑后 recoverable 自动消失。
- 失败或异常不破坏原恢复点。
- 放弃恢复有明确状态。

## 后续工作

- 接入 headless agent service 或 desktop main service。
- 给最终 UI/IPC 暴露恢复摘要和 continue/abandon 操作。
- 增加真实 SiliconFlow + PostgreSQL 的 Plan & Execute 恢复 eval。
- 如果后续需要失败续跑历史，应扩展 store 为多版本快照或迁移 SQLite WAL。
