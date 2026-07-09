# desktop Agent 流式响应历史 IPC

## 目标

本模块把 `core-agent` 已有的 `AgentStreamStore` 接入 desktop 主进程。Agent 在 desktop 运行时会通过 `LlmRouter.stream()` 保存模型流式事件，后续 UI 可以读取完整 stream 记录、恢复未完成响应，或用于诊断和测试复盘。

当前阶段不开发 renderer UI，也不实现实时 `agent:event` 推送；本切片先完成后端持久化和查询合同。

## 存储位置

- 文件：`data/agent-streams.json`
- 创建方：`apps/desktop/src/main/main.ts`
- 写入方：`ReactAgent.callModel()` 在配置 `streamStore` 后自动写入

## IPC 合同

- `agent:streams`
  - 请求：`AgentStreamsRequest`
  - 响应：`AgentStreamsResponse`
  - 用途：按 session id 列出 stream 摘要。
- `agent:stream`
  - 请求：`AgentStreamRequest`
  - 响应：`AgentStreamDetail`
  - 用途：读取单个 stream 的 chunks、tool calls、usage 和最终文本。
- `agent:recoverable-streams`
  - 请求：`void`
  - 响应：`AgentStreamsResponse`
  - 用途：列出状态为 `streaming` 或 `incomplete` 的未完成 stream，供启动恢复和诊断使用。

## 事件类型

shared IPC 暴露的 `AgentStreamEvent` 包含：

- `text-delta`
- `tool-call-delta`
- `tool-call`
- `usage`
- `finish`

这些类型对齐 `@dbagent/core-llm` 的 `LlmChatStreamEvent`，但 shared 只保留可序列化合同，不直接导入 LLM 包类型。

## 恢复语义

- `complete`：模型流完整结束，并保存 final response。
- `streaming`：已经开始但未收到 finish，可作为异常退出后的候选恢复记录。
- `incomplete`：stream 过程中抛出非用户中止错误。
- `aborted`：用户主动中止。
- `failed`：显式标记失败。

`agent:recoverable-streams` 目前只返回 `streaming` 和 `incomplete`，不返回用户主动中止或已完成记录。

## 测试覆盖

- desktop 服务级测试验证一次真实 `HeadlessAgentService.run()` 在配置 stream store 后会使用 provider stream，并保存完整 stream 事件。
- 验证 `agent:streams` 摘要包含 session、provider、model、状态、文本、chunk 数和 tool call 数。
- 验证 `agent:stream` 详情包含 chunks、usage 和 finish response。
- 验证手动遗留的 `streaming` 记录可通过 recoverable streams 查询。
- core 既有 `stream-store.test.ts` 和 `react-agent.test.ts` 继续覆盖 stream store 原子写入、异常标记、脱敏和 ReactAgent 集成。

## 开源与依赖评估

本切片不新增第三方依赖。流式持久化使用已有 `AgentStreamStore` 和 `LlmRouter.stream()`。引入外部事件总线、队列或 tracing SDK 会增加运行时和打包成本；当前 beta 阶段只需要本地可恢复 stream 记录，后续实时 UI 推送可在此合同之上实现。

## 已知限制

- 当前只提供历史读取，不主动向 renderer 推送实时事件。
- stream store 当前使用 JSON 原子写入；大量长流式会话后续应迁移 SQLite WAL 或分文件存储。
