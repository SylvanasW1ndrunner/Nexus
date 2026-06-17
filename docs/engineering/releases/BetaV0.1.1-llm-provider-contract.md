# BetaV0.1.1 LLM Provider 合约

## 背景

当前开发路线是先完成功能模块，最后统一开发前端 UI。Agent 能力后续依赖稳定的 LLM provider 层，因此本次先补齐 `core-llm` 的 OpenAI-compatible 调用合约。

## 本次实现

- 新增 `OpenAICompatibleProvider`。
- 新增 SiliconFlow provider preset。
- 新增通用 LLM 类型：
  - message
  - tool
  - tool call
  - chat request / response
  - usage
  - provider error
- `LlmRouter` 支持注册 provider 并转发 chat 请求。
- `LlmRouter` 会把 BYOK token 用量写入 `UsageTracker`。
- `UsageTracker` 新增 `recordByokTokens()`，用于记录本地 BYOK token 估算。

## 安全约束

- API key 不写入代码、文档、测试快照或命令。
- 真实 provider 测试只读取环境变量：
  - `DBAGENT_LLM_API_KEY`
  - `DBAGENT_RUN_LLM_INTEGRATION=1`
- 默认测试使用 mock fetch，不访问外网、不消耗额度。
- BYOK 模式继续保持不要求登录。

## 用户级测试场景

已覆盖：

- 用户配置 OpenAI-compatible endpoint 后可发起 chat 请求。
- Provider 能解析普通文本响应。
- Provider 能解析工具调用响应。
- Provider 能记录 prompt / completion / total token。
- API key 错误时返回不可重试认证错误。
- 5xx / rate limit 等可重试错误会执行有限重试。
- Router 能把 provider token 用量写入本地 usage 记录。
- 未注册 provider 时给出明确错误。

真实 SiliconFlow 连通测试入口已保留，但当前环境未设置 `DBAGENT_LLM_API_KEY` 和 `DBAGENT_RUN_LLM_INTEGRATION`，因此默认跳过，避免泄露或误用密钥。

## 后续衔接

下一步 Agent 后端开发可以直接依赖：

- `LlmProvider`
- `LlmRouter.chat()`
- `LlmTool`
- `LlmToolCall`
- `LlmProviderError`

后续需要继续补：

- 流式响应解析。
- embeddings 接口。
- Anthropic / Azure OpenAI provider。
- Agent round 级 usage，与当前 provider token 记录合并。
