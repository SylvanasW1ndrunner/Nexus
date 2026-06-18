# core-llm 大模型接入模块

## 代码入口

- `packages/core-llm/src/types.ts`：LLM provider、消息、工具调用、流式事件、错误码和错误类型。
- `packages/core-llm/src/openai-compatible-provider.ts`：OpenAI-compatible HTTP provider，实现普通 chat、SSE stream、错误分类、超时、取消和重试。
- `packages/core-llm/src/llm-router.ts`：BYOK / subscription 路由决策，并把模型用量写入 `core-usage`。

## 开发逻辑

`core-llm` 不直接依赖 Electron，也不保存密钥。上层通过配置模块或主进程服务创建 provider，并把 API key 注入构造函数。provider 只负责调用外部 LLM 端点、解析响应、分类失败和暴露稳定合同。

当前主要 provider 是 `OpenAICompatibleProvider`。它服务于 SiliconFlow、OpenAI-compatible 网关和后续自建 vLLM/Ollama 兼容端点。请求格式采用 `/chat/completions`：

- 普通 chat：返回 `LlmChatResponse`，包含文本、工具调用、usage、provider response id 和模型名。
- 流式 stream：解析 SSE `data:` 事件，逐步产出 `text-delta`、`tool-call-delta`、`usage` 和最终 `finish`。
- 工具调用参数始终在 provider 内解析 JSON；解析失败时保留 `{ raw }`，避免丢失模型输出。

## 失败恢复策略

外部 LLM 属于不稳定依赖，所有失败必须转换为 `LlmProviderError`：

- `LLM_AUTH_FAILED`：API key 无效或无权限，不重试。
- `LLM_RATE_LIMITED`：HTTP 408 / 429，可重试。
- `LLM_TIMEOUT`：请求超时，可重试。
- `LLM_ABORTED`：用户主动取消，不重试，也不计为超时。
- `LLM_NETWORK_ERROR`：网络错误，可重试。
- `LLM_BAD_RESPONSE`：无效 JSON、空响应或无法解析的流式事件，按 provider 侧异常处理。
- `LLM_PROVIDER_ERROR`：HTTP 5xx 可重试，其他 provider 错误不重试。

普通 chat 和 stream 建连阶段都使用指数退避重试。退避等待本身会监听 `AbortSignal`，用户点击停止后不会继续等待下一次重试。stream 一旦连接成功并开始消费事件，不做中途重放；后续如果要恢复部分输出，应在 Agent/session checkpoint 层持久化已收到的 stream chunk。

## SiliconFlow 预设

`createSiliconFlowProvider()` 固定：

- `id`: `siliconflow`
- `name`: `SiliconFlow`
- `baseUrl`: `https://api.siliconflow.cn/v1`

测试阶段真实调用通过环境变量门控，不把 API key 写入代码、文档、测试快照或提交记录。默认单元测试只使用 fake fetch。

## 测试覆盖

- `openai-compatible-provider.test.ts`：请求体、响应解析、usage、工具调用、SSE 流式解析、认证失败不重试、provider 临时失败重试、用户取消不重试、退避期间取消、stream 建连失败重试、SiliconFlow 预设和真实集成门控。
- `llm-router.test.ts`：BYOK / subscription 路由、普通 chat 用量记录、Agent round 用量归因、provider 失败不计为完成用量、流式 usage 记录和非流式 fallback。

## 已知边界

- 当前不实现 subscription gateway 服务端，只保留路由合同。
- 当前不在 provider 内持久化 stream chunk；恢复由后续 Agent checkpoint/session store 处理。
- 当前不做 provider 自动选择；上层必须指定 provider id。
