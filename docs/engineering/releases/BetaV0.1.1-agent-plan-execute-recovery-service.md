# BetaV0.1.1 Agent Plan & Execute 恢复服务

## 变更

- 新增 Plan & Execute 恢复服务。
- 支持列出 recoverable plan、继续执行、放弃恢复。
- 继续执行自动注入 `initialPlan`、`initialSession`、`initialExecutedSteps`、`initialTotalIterations`。
- 完成续跑后清理 recoverable；失败或异常时保留原恢复点。
- 导出 `PlanExecuteRecoveryService` 别名，方便后续服务层使用。

## 验证

- core-agent 类型检查、lint、全量测试通过。
- core-tools 类型检查通过。
- Agent/RAG 下游关键测试通过。
- 已重建 core-agent dist。

## 打包影响

- 无新增依赖。
- 无 native module 变化。
- 无 Electron 打包配置变化。

## 风险

- 当前仅是 core 层恢复服务，尚未接 desktop IPC 或最终 UI。
- `restart` 目前只是动作枚举，后续由上层重新发起任务实现。
- 当前只保存最新快照，不保存每次恢复失败的独立 plan 历史。
