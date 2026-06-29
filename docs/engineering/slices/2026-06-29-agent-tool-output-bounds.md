# 2026-06-29 Agent 工具结果限幅切片

## 背景

当前开发路径是先做完整后端能力，再统一重建前端。Agent 工具调用是后续 RAG、SQL、Python 和 MCP 插件体系的中心路径。真实数据分析任务中，工具很容易返回大结果，必须在后端层先保证上下文和持久化安全。

## 本次实现

- 在 `ReactAgent` 工具执行路径中新增统一序列化和限幅。
- `AgentRunOptions.maxToolResultChars` 现在不仅用于上下文压缩，也用于工具结果写回 session/checkpoint 前的上限控制。
- 默认持久化工具结果上限为 `12000` 字符。
- 超长结果被替换为结构化摘要，保留 head/tail 和原始长度。
- 修正工具超时文案，使超时毫秒数真实进入错误消息。
- 顺手修正 `react-agent.test.ts` touched-file lint 问题。

## 不做的事

- 不引入外部 tracing/eval 依赖。
- 不实现完整原始结果 artifact store。
- 不改 UI。
- 不改工具注册、权限和 allowlist 合同。

## 测试

- 新增长结果用户场景测试：
  - 模拟 `query_database` 返回 500 行大 payload。
  - 断言 session tool message、tool execution preview、下一轮模型输入都只包含限幅摘要。
  - 断言完整尾部 payload 不进入模型上下文。
- 回归测试：
  - 工具超时恢复。
  - 连续失败熔断。
  - allowlist 和权限路径。

## 质量结论

该切片降低了 Agent 对大 SQL/Python/MCP 输出的上下文风险，是后续真实用户级 Agent/RAG 测试前的基础韧性补强。
