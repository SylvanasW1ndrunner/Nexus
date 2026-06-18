# BetaV0.1.1 MCP 容错基础

## 范围

本次新增 `packages/core-tools/src/mcp-health.ts`，为后续 MCP Client Manager 提供纯后端健康管理合同。该切片不开发前端 UI，不直接启动 MCP 子进程。

## 能力

- 维护 MCP server 状态：`stopped`、`starting`、`healthy`、`unhealthy`、`restarting`、`disabled`。
- 记录进程退出码、退出信号、最后错误、资源采样和下一次重启时间。
- 对进程异常退出执行指数退避重启决策，默认最多 3 次。
- 对内存超限执行重启决策，避免内存泄漏拖垮桌面应用。
- 对持续 CPU 超限记录告警，但不立即中断工具，避免误伤短时间重任务。
- 对卡死 MCP 工具调用执行硬超时，即使工具忽略 `AbortSignal` 也会返回。
- 区分调用超时 `McpToolTimeoutError`、用户取消 `McpToolAbortedError` 和 server 不可用 `McpUnavailableError`。

## 用户价值

用户在本地连接多个 MCP server 时，单个第三方工具卡死、崩溃或资源异常，不应导致整个 Agent 任务或应用不可用。该合同为后续实现“禁用坏 server、继续使用其他工具、把错误回传给 Agent 修复”的体验打基础。

## 测试

新增 `packages/core-tools/test/mcp-health.test.ts`，覆盖：

- 启动和健康状态流转。
- 单个 server 不可用不影响其他 server。
- 进程退出后指数退避和重启上限。
- 用户禁用 server 后不自动重启。
- 内存超限触发重启并避免重复告警。
- 持续 CPU 超限只记录告警。
- MCP 工具正常返回。
- MCP 工具卡死且忽略取消时仍按超时失败。
- 超时后内部 `AbortSignal` 被触发。
- 外部取消和超时错误分离。

## 已知边界

- 当前只提供健康状态和超时合同，不负责实际 `spawn`、`kill`、stdio 连接或 MCP SDK 适配。
- CPU 采样策略后续需要接入真实子进程监控后再校准阈值。
- 自动重启只返回决策时间，真正调度重启由后续 MCP Client Manager 实现。
