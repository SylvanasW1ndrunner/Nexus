# core-agent 上下文预算治理模块

## 目标

Agent 进入真实使用后，会持续积累用户消息、工具调用、RAG 片段和模型回复。没有预算治理时，长会话会出现三个问题：

- 提示词超出模型上下文窗口，导致任务失败。
- 大工具结果反复进入下一轮模型上下文，浪费 token。
- 压缩行为不可观测，后续 UI、审计日志和行为评估无法解释 Agent 为什么“忘掉”早期上下文。

本模块将上下文构建从“临时裁剪”升级为可观测的预算治理能力。

## 代码入口

- `packages/core-agent/src/context-manager.ts`
  - `buildAgentContext()` 构建发给模型的 messages/tools。
  - `estimatePromptTokens()` 提供轻量本地 token 估算。
  - 压缩报告包含预算阶段、阈值、步骤和压缩后 token 估算。
- `packages/core-agent/src/types.ts`
  - `AgentContextCompressionReport`
  - `AgentContextCompressionPhase`
  - `AgentContextCompressionStep`
  - `AgentRunResult.contextCompression`
- `packages/core-agent/src/react-agent.ts`
  - 每轮 ReAct 构建上下文后保存压缩报告。
  - 非 healthy 阶段写入 `context_compression_applied` 审计事件。
- `packages/core-agent/src/audit-log-store.ts`
  - 新增 `context_compression_applied` 事件类型。

## 阶段语义

- `healthy`：低于 warning 阈值，不压缩。
- `warning`：超过 warning 阈值，但还未触发本地压缩。
- `soft_compressed`：触发工具结果摘要，仍在预算内。
- `hard_compressed`：触发早期消息归档，压缩后在预算内。
- `over_budget`：本地压缩后仍超过预算，需要上层提示用户或后续引入更强压缩策略。

默认阈值：

- warning：`maxPromptTokens * 0.6`
- soft compression：`maxPromptTokens * 0.8`
- hard compression：`maxPromptTokens * 0.95`

## 压缩步骤

当前支持两类本地压缩：

- `tool-summary`：对超长 tool message 保留开头、结尾、原始长度和摘要说明。
- `archive-early-messages`：保留 system message 和最近 N 条非 system message，将更早消息替换为归档摘要。

每个步骤记录：

- `beforeTokenEstimate`
- `afterTokenEstimate`
- `affectedMessageCount`

报告不包含原始消息内容，因此可以进入审计日志。

## 开源方案评估

本切片没有新增依赖。

- `js-tiktoken`、`gpt-tokenizer` 等库能提供更准的 token 估算，但会引入模型编码表和打包体积；当前阶段模型提供方多且会接入国产 OpenAI-compatible provider，精确编码收益有限。
- LangChain/LlamaIndex 的 memory summarization 更适合完整 agent framework，但会把 DBAgent 的 session、checkpoint、审计、工具权限语义交给外部抽象，当前不适合直接接管。
- 当前采用轻量本地估算和 deterministic 压缩，优先稳定 DBAgent 自身运行契约；后续可以在 `estimatePromptTokens()` 后接入 provider-specific tokenizer adapter。

## 测试覆盖

- `packages/core-agent/test/context-manager.test.ts`
  - healthy、warning、tool-summary、archive、over-budget、token 估算。
- `packages/core-agent/test/react-agent.test.ts`
  - 恢复已有长会话时，Agent run 返回压缩报告。
  - 非 healthy 压缩写入审计事件。
  - 模型上下文中出现本地摘要而非完整大工具结果。
- `packages/core-agent/test/audit-log-store.test.ts`
  - 审计事件仍能正常持久化与读取。

## 已知边界

- 当前 token 估算是启发式，不能保证和每个模型 provider 完全一致。
- 当前归档摘要是本地 deterministic 摘要，不调用 LLM，因此不会产生语义级长记忆总结。
- `over_budget` 不会自动中断 Agent run；当前只报告风险，后续可接入用户提示、强制压缩或廉价模型总结。
