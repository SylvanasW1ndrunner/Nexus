# core-agent 工具结果限幅模块

## 模块目标

Agent 会调用 SQL、Python、MCP、工作区脚本等工具。真实用户场景里，这些工具可能返回数万行结果、长日志、异常堆栈或无法 JSON 序列化的对象。如果直接写入 session、checkpoint 和下一轮 LLM 上下文，会带来三个问题：

- 上下文膨胀，导致模型调用失败或成本失控。
- 本地 session/checkpoint 文件快速膨胀。
- Agent 在错误恢复时被无关大输出淹没。

本模块在 `ReactAgent` 工具执行路径中统一处理工具结果序列化和限幅。

## 代码入口

- `packages/core-agent/src/react-agent.ts`
  - `serializeToolResult(result, maxChars)`：安全序列化工具结果。
  - `limitSerializedToolResult(content, maxChars)`：对超长结果生成结构化摘要。
  - `maxToolResultChars`：复用 `AgentRunOptions.maxToolResultChars`，默认持久化上限为 `12000` 字符。

## 行为规则

- 字符串结果按原样处理。
- 对象结果使用 `JSON.stringify()`。
- 无法序列化的结果返回结构化错误，不让 Agent run 崩溃。
- 超长结果不会完整写入 session。
- 超长摘要保留：
  - `truncated: true`
  - `reason: "tool_result_too_large"`
  - 中文摘要说明
  - 原始字符数
  - head/tail 片段
- 工具超时文案修正为包含真实毫秒数。

## 开源借鉴与依赖判断

本切片没有引入新依赖。原因是当前需求是运行时输出限幅，不需要外部 tracing 或 observability 框架。

借鉴方向：

- OpenTelemetry、LangSmith、LangGraph 等项目都会把 tool observation 和 trace/event 分层存储；本切片先在 DBAgent 自有 session/checkpoint 合同内实现最小限幅。
- 后续如果接入 tracing/eval 框架，应通过 adapter 暴露 sanitized observation，不能把第三方 trace 类型放进 `core-agent` 公共类型。
- 原始大结果长期应进入 artifact/archive store，本切片只保证默认 Agent 上下文安全，不替代完整结果归档。

## 测试覆盖

- `packages/core-agent/test/react-agent.test.ts`
  - 长工具结果在写入 session 前被限幅。
  - 下一轮模型输入只能看到摘要，不包含完整尾部大 payload。
  - timeout 工具仍会中断并进入恢复流程。
  - touched-file lint 覆盖测试 helper。

## 后续扩展

- 增加工具原始结果 artifact 存储，支持用户在 UI 中查看完整结果。
- 对 SQL/Python/MCP 分别设置默认上限和 archive 策略。
- 将工具结果摘要纳入 Agent 诊断报告。
