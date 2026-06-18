# BetaV0.1.1 LLM 调用恢复能力增强

## 范围

本次切片增强 `core-llm` 的外部 LLM 调用稳定性，不涉及前端 UI。

新增能力：

- 新增 `LLM_ABORTED` 错误码，区分用户主动取消和请求超时。
- 普通 chat 的重试退避等待支持 `AbortSignal`，用户停止后不会继续等待下一次重试。
- stream 建连阶段支持和 chat 一致的可重试错误处理。
- `OpenAICompatibleProvider` 增加 `retryDelayBaseMs` 配置，便于测试和后续配置化。
- SiliconFlow provider 预设透传 `retryDelayBaseMs`。

## 用户场景

- 用户配置的模型服务临时返回 429 / 5xx 时，系统会自动重试，减少偶发失败。
- 用户点击停止 Agent 任务时，LLM 请求会返回 `LLM_ABORTED`，不会被误判成超时，也不会继续重试。
- 流式回答在建立连接前遇到短暂限流，可以重试后继续开始输出。

## 测试

已覆盖：

- 认证失败不重试。
- provider 临时失败后重试成功。
- 预先取消的 chat 请求返回 `LLM_ABORTED`。
- 退避等待期间取消会立即停止，不发起下一次请求。
- stream 建连阶段遇到 429 后重试成功并正常产出事件。
- SiliconFlow 真实集成测试继续保留环境变量门控。

## 打包影响

无新增依赖。该切片只修改 TypeScript 逻辑和类型合同，不引入 native 模块，也不改变 Electron 打包内容。
