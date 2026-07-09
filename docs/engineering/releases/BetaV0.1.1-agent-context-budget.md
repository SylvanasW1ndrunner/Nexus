# BetaV0.1.1 Agent 上下文预算治理

## 变更

- Agent 上下文构建新增预算阶段和压缩步骤报告。
- `AgentRunResult` 新增 `contextCompression`，用于测试、服务层和后续 UI 展示。
- 审计日志新增 `context_compression_applied` 事件。
- 长会话恢复场景下，大工具结果会以摘要形式进入模型上下文。

## 验证

- core-agent 类型检查、lint、全量测试通过。
- core-tools 类型检查和 Agent/RAG 关键下游测试通过。
- 已重建 core-agent dist。

## 打包影响

- 无新增依赖。
- 无 native module 变化。
