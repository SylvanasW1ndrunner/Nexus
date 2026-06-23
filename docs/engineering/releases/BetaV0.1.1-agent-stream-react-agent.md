# BetaV0.1.1 ReactAgent Stream 持久化接入

## 范围

本次切片把上一轮新增的 `AgentStreamStore` 接入 `ReactAgent` 主循环，不涉及前端 UI。

新增能力：

- `AgentRunDependencies` 增加 `streamStore`。
- `ReactAgent` 在传入 `streamStore` 时使用 `LlmRouter.stream()` 调用模型，并通过 `persistAgentStreamEvents()` 将 stream event 实时落盘。
- 未传入 `streamStore` 时保持原有 `LlmRouter.chat()` 路径，避免影响现有非流式调用方。
- stream 中断时，已收到文本会被标记为 `incomplete` 并进入可恢复列表。
- stream 正常完成时，store 记录完整 final response、usage、model、provider、round id 和 chunk 序列。

## 用户场景

- 用户运行长 Agent 分析时，如果模型已经输出一半后网络断开，后端能保留这部分输出，后续启动恢复扫描可提示用户继续或重试。
- 用户正常完成一次 Agent run 后，stream store 中能追溯模型输出过程，便于诊断“模型什么时候开始调用工具/什么时候生成最终回答”。
- 默认非流式 Agent run 不受影响，降低集成风险。

## 测试

已覆盖：

- ReactAgent 使用 streaming provider 完成业务回答，并把 stream chunk 写入 `AgentStreamStore`。
- stream store 记录 session id、round id、provider id、model、final text 和 chunk 序号。
- streaming provider 中途抛出网络错误时，ReactAgent run 失败、usage round 记录为 failed、usedRounds 不增加，同时 stream store 保留 partial text 并进入 recoverable 列表。
- 原有 ReactAgent 权限、checkpoint、context 压缩、usage 和工具调用测试继续通过。

## 打包影响

无新增依赖。仅复用已有 `LlmRouter.stream()`、`AgentStreamStore` 和 Node.js 文件持久化能力。

## 已知边界

- 当前 `ReactAgent.run()` 仍返回最终 `AgentRunResult`，不向调用方逐条 yield UI event。后续主进程 `agent:run` 流式 IPC 可基于同一 `streamStore` 和 `LlmRouter.stream()` 事件模型扩展。
- stream store 当前使用 JSON 文件，后续大量并发会话应迁移到 SQLite WAL。
