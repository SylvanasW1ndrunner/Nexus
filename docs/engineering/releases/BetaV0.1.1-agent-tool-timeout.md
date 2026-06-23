# BetaV0.1.1 Agent 工具执行超时

## 范围

本切片为 `packages/core-agent` 增加 Agent 层统一工具超时保护，不改动前端 UI。

## 用户场景

数据工程师让 Agent 调用数据库、Python、MCP 或 shell 工具时，外部进程、网络或长 SQL 可能卡住。Agent 不能无限等待，也不能让用户误以为任务仍在正常推进。本能力让单次工具调用默认 60 秒超时，并把超时作为可诊断的工具失败返回给模型。

## 实现

- `AgentRunOptions.maxToolExecutionMs`：可配置单个工具调用超时时间，默认 60000ms。
- `ReactAgent` 在执行工具时创建子 `AbortSignal`，超时后触发 abort。
- 超时错误写入 tool message，格式为稳定中文：`工具 <toolName> 执行超时（<timeoutMs>ms）。`
- 超时计入现有连续工具失败熔断；达到阈值后返回 `tool_failed`，保存 failed checkpoint，并把 usage round 关闭为 failed。

## 开源与依赖评估

本切片未引入新依赖。原因：

- 所需能力是 `Promise.race`、`AbortController` 和现有 Agent 工具合同的薄层编排。
- 引入外部超时库不会明显降低复杂度，反而增加 Electron 打包和离线分发检查成本。
- 具体 MCP、Python、shell、数据库工具后续仍需要在各自模块实现进程 kill、连接取消和输出截断；Agent 层只负责统一兜底与恢复语义。

## 测试

- `react-agent.test.ts` 覆盖工具挂起后超时、工具收到 abort signal、错误回传给模型后继续恢复。
- `react-agent.test.ts` 覆盖超时进入连续失败熔断，确认不会继续消耗完整迭代预算。
- 保留现有工具异常恢复、checkpoint、stream、权限、quota 和 provider 失败测试。

## 已知边界

- Agent 层只能触发工具收到的 `AbortSignal`；如果具体工具忽略 signal，底层资源释放要由工具模块自己实现。
- 本切片不改变数据库长查询取消、MCP 子进程重启、Python 进程 kill 的具体实现，这些属于后续各工具模块的可靠性工作。
