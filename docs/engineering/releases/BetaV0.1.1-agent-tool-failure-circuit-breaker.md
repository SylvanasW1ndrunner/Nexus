# BetaV0.1.1 Agent 工具连续失败熔断

## 范围

本次切片增强 `ReactAgent` 的失败控制能力，不涉及前端 UI。

新增能力：

- `AgentRunOptions.maxConsecutiveToolFailures` 支持配置连续工具失败阈值。
- 默认连续 3 次工具执行失败后，Agent 停止运行并返回 `tool_failed`。
- 停止时保存 failed checkpoint，记录最终错误说明。
- usage round 关闭为 `failed`，不计入成功/中止轮次。
- 单次工具失败仍会写入 tool message 并回传给模型，让下一轮有机会修复。

## 用户场景

- 数据库连接持续中断、MCP 工具持续不可用或模型反复调用错误工具时，Agent 不会一直消耗到最大迭代次数。
- 用户或后端恢复入口可以看到明确的 `tool_failed` 结果、最后一次错误和完整工具执行记录。
- 对于“SQL 写错一次但下一轮可修正”的场景，Agent 不会过早停止。

## 测试

已覆盖：

- 单次 SQL 工具失败后，模型下一轮修正并成功完成。
- 连续三次工具失败后，Agent 返回 `tool_failed`。
- 熔断后 checkpoint 最新状态为 `failed`，不进入 recoverable 列表。
- 熔断后 usage round 为 `failed`，`usedRounds` 不增加。
- 原有权限、checkpoint、stream、context 压缩、subscription quota 和 provider 失败测试继续通过。

## 打包影响

无新增依赖。

## 已知边界

- 当前熔断按连续失败次数统计，不区分 SQL 语法错误、远程数据库网络错误、MCP 不可用或工具不存在。
- 后续可以按错误类型增加不同策略：SQL 语法错误允许更多自修复，网络错误可先重连，MCP 不可用可禁用对应 server 并让 Agent 改用其它工具。
