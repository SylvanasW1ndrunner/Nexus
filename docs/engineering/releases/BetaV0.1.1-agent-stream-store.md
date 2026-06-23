# BetaV0.1.1 Agent Stream 持久化

## 范围

本次切片增强 `core-agent` 的流式响应恢复能力，不涉及前端 UI。

新增能力：

- 新增 `AgentStreamStore`。
- 保存 LLM stream event：`text-delta`、`tool-call-delta`、`tool-call`、`usage`、`finish`。
- 累计部分文本、工具调用、usage 和最终响应。
- `markIncomplete()` 用于网络中断或 provider stream 异常后保留部分输出，并让启动恢复扫描能发现该 stream。
- `markAborted()` 用于用户主动停止，保留部分输出但不提示恢复。
- 新增 `persistAgentStreamEvents()`，可包裹 `LlmRouter.stream()`，边转发事件边落盘，异常时自动标记 incomplete/aborted。
- stream store 复用 agent 持久化脱敏规则，避免 API key、Bearer token、数据库连接串密码等进入恢复文件。

## 用户场景

- 长 Agent 分析过程中网络断开，用户重启后仍能看到已经生成的部分回答。
- Provider stream 中途失败时，后端有明确的 `incomplete` 状态，而不是丢掉已有文本。
- 用户主动停止 Agent 时，部分输出保留为历史，但不会被当成异常恢复任务反复提示。

## 开源评估

候选方向：

- Vercel AI SDK stream helpers：适合 UI/HTTP streaming，但需要引入 SDK 抽象并改变当前 `LlmRouter` 合同。
- LangChain/LangGraph callback + checkpoint：适合完整框架化 Agent runtime，但当前权限、usage、tool registry 已有自有合同。
- 自研轻量 stream store：适合当前已有 `LlmChatStreamEvent` 类型和本地 JSON 原子写入策略。

本次选择自研轻量 store。原因是目标是补齐 DBAgent 自有 stream event 的持久化和恢复状态，不需要引入新的运行时框架。后续如果引入框架化 Agent runtime，应通过 adapter 转换为 DBAgent 自有 stream event 和恢复记录。

## 测试

已覆盖：

- 完整 stream 保存 chunk、usage、final response，完成后不进入恢复列表。
- 网络中断时保留 partial text，并进入 recoverable 列表。
- 用户中止时标记 aborted，不进入 recoverable 列表。
- tool call 和错误信息里的敏感字段被脱敏。
- 损坏 stream JSON 降级为空列表，保证启动继续。
- `persistAgentStreamEvents()` 包装 provider stream 时，正常事件落盘，异常自动标记 incomplete/aborted。

## 打包影响

无新增依赖。仅使用 TypeScript 和 Node.js 文件系统能力。

## 已知边界

- 当前尚未接入 `ReactAgent.run()` 默认路径；后续流式 Agent IPC 接线时应通过 `persistAgentStreamEvents()` 包裹 `LlmRouter.stream()`。
- 当前仍使用 JSON 文件，后续大量 stream 历史和并发写入应迁移到 SQLite WAL。
