# BetaV0.1.1 - Agent 上下文预算与本地压缩

## 背景

Agent 长会话会不断累积用户消息、工具调用结果、Schema/RAG 片段和中间观察。如果不在发给模型前控制上下文长度，真实模型调用会出现上下文超限、成本失控或关键最近任务被早期大结果挤掉。

本切片实现无 UI 的 Agent context manager，用确定性本地策略先解决基础预算控制。

## 变更内容

- 新增 `packages/core-agent/src/context-manager.ts`。
- 新增 `buildAgentContext()`：
  - 估算 prompt token。
  - 大型 tool result 本地摘要化。
  - 超预算时归档早期消息，并保留最近消息。
  - 返回压缩报告：原始/最终 token 估算、压缩等级、归档数量、工具结果摘要数量和 warning。
- 新增 `estimatePromptTokens()` 作为轻量估算器。
- `AgentRunOptions` 新增：
  - `contextWindowTokens`
  - `keepRecentMessages`
  - `maxToolResultChars`
- `ReactAgent` 每轮模型调用前通过 context manager 构造 messages/tools。

## 开源评估

本切片不引入 `tiktoken`、`js-tiktoken` 或 LangChain/LlamaIndex memory 模块。原因：

- 当前需要先形成 DBAgent 自有的 Agent Session、Tool Registry、Permission 和 Usage 合同。
- 轻量估算和本地压缩不需要 native 或模型依赖，打包和离线风险更低。
- 后续接入真实 tokenizer 或 memory 框架前，应按 `docs/engineering/open-source-first.md` 评估许可证、包体、WASM/native、Electron 打包和模型兼容。

## 测试覆盖

- 小会话保持原样，不误压缩。
- 大型工具结果会被本地摘要化，并降低 token 估算。
- 长会话会归档早期消息，保留最近上下文。
- 极小预算下返回 warning，不静默假装成功。
- ReactAgent 调用模型前实际使用压缩后的 messages。

## 已知限制

- 当前 token 估算是近似值，不等同于具体模型 tokenizer。
- 当前摘要是本地截断摘要，不调用 LLM 写自然语言摘要。
- 当前压缩报告没有持久化到 session message；后续 UI/恢复入口需要把压缩事件纳入 checkpoint 或 session metadata。
