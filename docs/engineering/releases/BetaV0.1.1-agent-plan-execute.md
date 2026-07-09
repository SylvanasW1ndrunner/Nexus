# BetaV0.1.1 Agent Plan & Execute

## 变更

- 新增 `PlanExecuteAgent` 后端策略骨架。
- 新增计划、步骤和计划执行结果类型。
- Plan 阶段通过模型生成结构化步骤，Execute 阶段复用现有 ReAct runner。
- 步骤失败后默认停止，并把剩余步骤标记为跳过。
- 非法计划不会进入执行阶段。

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

- 当前计划未持久化，重启恢复仍需要后续 checkpoint 集成。
- 当前不支持计划确认 UI 和 DAG 并行执行。
- 当前未跑真实 LLM live eval，后续真实业务库 Agent/RAG 测试应覆盖该策略。
