# BetaV0.1.1 LLM 流式调用合约

## 背景

产品文档要求 Agent 响应、工具调用和 usage 能够以事件流形式输出。最终 UI 暂缓开发，但后端必须先提供稳定的流式合约，否则后续 Agent 事件面板、停止恢复、长任务进度和真实用户体验都会被非流式接口限制。

## 本次变更

- `packages/core-llm`
  - 新增 `LlmChatStreamEvent`：
    - `text-delta`
    - `tool-call-delta`
    - `tool-call`
    - `usage`
    - `finish`
  - `LlmProvider.stream` 作为可选能力加入 provider 合约。
  - `LlmRouter.stream()` 暴露统一流式入口。
  - provider 不支持流式时，Router 会回退到 `chat()`，并输出 text/usage/finish 等价事件。
- `OpenAICompatibleProvider`
  - 调用 `/chat/completions` 时加入 `stream: true` 和 `stream_options.include_usage`。
  - 解析 OpenAI-compatible SSE。
  - 支持文本 delta、工具调用函数名/参数分片、usage 和 finish reason。
  - 在 finish response 中重组成完整 `LlmChatResponse`，包括完整工具调用参数。

## 用户级场景

- 用户运行长 Agent 分析时，后端可以立即产出文字增量，避免等待完整响应后才显示结果。
- 模型流式返回工具调用参数时，后端可以观察每个分片，并最终得到可执行的完整工具调用。
- usage 在流式完成后进入统一计量路径，后续订阅配额与 BYOK token 估算不需要区分流式/非流式。
- 不支持流式的 provider 仍可使用统一 Router 流式入口，降低后续 Agent 代码分支。

## 测试

- 单元测试覆盖：
  - OpenAI-compatible 文本 SSE 解析。
  - 工具调用参数跨 chunk 拼接。
  - Router 对 provider 原生流式的转发和 usage 归属。
  - Router 对非流式 provider 的 fallback。
- 真实 SiliconFlow 测试入口：
  - `DBAGENT_RUN_LLM_INTEGRATION=1`
  - `DBAGENT_LLM_API_KEY=<运行时注入>`
  - 默认跳过，避免本地默认测试访问外网或泄露密钥。

## 打包影响

本次未新增第三方依赖，只使用 Node/Electron 运行时已有的 `fetch`、`ReadableStream`、`TextDecoder`。
