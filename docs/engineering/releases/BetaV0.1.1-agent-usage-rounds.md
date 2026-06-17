# BetaV0.1.1 Agent Round 用量计量

## 背景

产品文档要求 Agent 用量以“一次用户输入到一次完整 Agent 响应”为一轮，而不是按单次 LLM 调用或单个工具调用计量。此前 `core-usage` 只有快照式 `recordLocalQuery()` 和 token 估算，无法表达用户中止、系统失败、订阅配额耗尽、round 内多次 LLM 调用等真实场景。

## 本次变更

- `packages/core-usage`
  - 增加 `startConversationRound()`、`recordLlmCall()`、`endConversationRound()`、`roundHistory()`、`getCurrentQuota()`。
  - 存储升级为版本化 JSON：`snapshots` 保持原有 IPC 兼容，`rounds` 保存 Agent round 诊断历史。
  - 兼容旧版 `UsageSnapshot[]` 文件，升级后不丢失历史。
  - `success` 和 `aborted` 计入已用轮次；`failed` 只记录诊断，不增加已用轮次。
- `packages/core-llm`
  - `LlmRouter.chat()` 支持传入 `round`。
  - 有 round 时，provider token usage 归属到 round；无 round 时保留旧的 BYOK token 快照逻辑。
- `packages/core-agent`
  - Agent run 开始时创建 usage round。
  - `usageMode: 'subscription'` 时先检查本地配额，耗尽则返回 `quota_exceeded`，不会调用模型。
  - 正常完成、权限拒绝、token 预算耗尽和用户中止会关闭 round。
  - provider 基础设施异常会关闭为 `failed`，不计入已用轮次。

## 用户级场景

- 用户让 Agent 完成一次多步分析，期间调用多次 LLM 和工具：最终只计 1 轮，token 汇总到该 round。
- 用户主动中止 Agent：已消耗资源，计 1 轮。
- provider 超时或网络失败导致 Agent 无法开始有效响应：记录失败诊断，不计入轮次。
- 订阅配额耗尽：Agent 不调用模型，避免继续产生费用。

## 验证

- `packages/core-usage/test/usage-tracker.test.ts`
  - 成功 round 持久化、token 汇总、旧格式兼容。
  - 用户中止计费、系统失败不计费。
  - 订阅配额状态。
- `packages/core-llm/test/llm-router.test.ts`
  - round token 归属。
  - provider failure 不制造已完成 round。
- `packages/core-agent/test/react-agent.test.ts`
  - 订阅配额耗尽不调用模型。
  - 用户中止计入 round。
  - provider 异常不计入已用轮次。

## 已知边界

- 当前订阅配额仍是客户端骨架，云端 gateway、JWT 和服务端权威配额尚未接入。
- 时间窗口滚动策略尚未实现；当前保留 `windowStartedAt`/`windowEndsAt` 字段，为后续 5 小时窗口扩展预留。
