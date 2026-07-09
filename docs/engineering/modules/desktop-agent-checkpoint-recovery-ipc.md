# desktop Agent ReAct checkpoint 恢复 IPC

## 目标

本模块把 `core-agent` 已有的 ReAct checkpoint 恢复能力接入 desktop 主进程，形成稳定 typed IPC 合同。当前阶段不开发 renderer UI，但后续恢复面板可以直接调用这些接口完成“列出可恢复任务、继续执行、放弃恢复”。

## 边界

- `packages/core-agent` 负责 checkpoint 持久化、恢复摘要、继续执行和放弃恢复。
- `apps/desktop/src/main/agent-service.ts` 负责 desktop 编排：生成 runId、绑定 AbortController、按当前请求重新计算工具权限、调用 `AgentRecoveryService`，并把 core 结果转换为 shared DTO。
- `packages/shared/src/ipc.ts` 只暴露可序列化合同，不依赖 Electron 或 core-agent 类型。
- `apps/desktop/src/main/main.ts` 复用同一个 `AgentCheckpointStore` 驱动 `ReactAgent` 和 `AgentRecoveryService`，避免恢复服务读取另一份状态。

## IPC 合同

- `agent:recoverable-checkpoints`
  - 请求：`void`
  - 响应：`AgentRecoverableCheckpointsResponse`
  - 用途：列出当前仍处于 running 状态、可恢复的 ReAct checkpoint。
- `agent:continue-checkpoint`
  - 请求：`AgentContinueCheckpointRequest`
  - 响应：`AgentContinueCheckpointResponse`
  - 用途：从历史 session、消息、工具结果和中断 iteration 继续执行。
- `agent:abandon-checkpoint`
  - 请求：`AgentAbandonCheckpointRequest`
  - 响应：`AgentAbandonCheckpointResponse`
  - 用途：把指定 session 下仍可恢复的 checkpoint 标记为 abandoned。

## 权限策略

恢复执行不信任历史 UI 状态，也不默认继承旧运行时的工具权限。`continueCheckpoint` 会按本次请求的 `mode`、启停插件、权限上限和 readonly 设置重新计算工具 allowlist，再传入 `ReactAgent`。

这样可以保证：

- 用户在恢复前切到 readonly，恢复运行不会获得写工具。
- 旧 checkpoint 只代表历史执行上下文，不代表当前授权。
- 即使模型尝试调用当前未暴露工具，也会在 runtime 被拒绝。

## 生命周期

1. ReAct 运行时通过 `AgentCheckpointStore` 写入 running checkpoint。
2. 应用重启或任务异常后，`agent:recoverable-checkpoints` 返回可恢复摘要。
3. 用户继续时，`agent:continue-checkpoint` 注入旧 session 和旧 iteration，从下一轮继续。
4. 继续成功且结果为 done 时，旧 running checkpoint 标记为 abandoned，新完成 checkpoint 写入同一 store。
5. 继续失败、中止或未完成时，旧 running checkpoint 保持可恢复。
6. 用户放弃时，`agent:abandon-checkpoint` 标记 abandoned，后续列表不再返回。

## 开源与依赖评估

本切片没有新增第三方依赖。恢复能力复用项目内 `core-agent` 的 checkpoint/store/recovery 服务，desktop 层只做 IPC 和编排。引入 LangGraph、Temporal、BullMQ 等外部运行时会增加状态模型迁移、Electron 打包、Windows 本地安装和 adapter 成本；当前收益不足。后续如果需要外部 agent runtime，应放在 adapter 后，不污染 shared IPC 合同。

## 测试覆盖

- 使用真实临时 JSON checkpoint store 列出 recoverable ReAct checkpoint。
- 通过 `HeadlessAgentService.continueCheckpoint` 走真实 `AgentRecoveryService` 与 `ReactAgent` 恢复路径。
- 验证恢复请求按当前 readonly 工具策略暴露工具。
- 验证恢复成功后旧 checkpoint 变为 abandoned，新 checkpoint 变为 done。
- 验证用户放弃恢复后列表为空，持久化状态为 abandoned。

## 已知限制

- 当前 IPC 只实现 ReAct checkpoint 的 continue 和 abandon；core 摘要里的 `restart` action 先作为未来 UI 行为提示保留。
- 默认测试使用 deterministic fake provider；真实 SiliconFlow/DeepSeek 恢复 eval 继续放在 gated live test 中执行。
