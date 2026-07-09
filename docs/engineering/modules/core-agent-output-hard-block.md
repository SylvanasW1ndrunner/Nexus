# core-agent 输出安全硬阻断模块

## 目标

本模块在既有输出脱敏层之上增加硬阻断能力，解决“Agent 任务本身合法，但工具结果或最终回复意外包含敏感行级数据”的问题。

典型场景：

- 用户要求按城市统计客户数。
- 模型第一次生成的 SQL 意外查询了 `email`、`phone`、`phone_enc`。
- 数据库工具真实返回了行级邮箱、手机号和加密字段。
- Agent 不应把这些结果写入会话、checkpoint、审计日志或下一轮模型上下文。
- Agent 应收到一个安全的结构化错误，然后改写为聚合查询继续完成任务。

## 代码入口

- `packages/core-agent/src/output-safety.ts`
  - `sanitizeAgentOutputValue()` 和 `sanitizeAgentOutputText()` 返回 `blocked` 字段。
  - `blockedAgentToolResultMessage()` 生成安全的工具阻断消息。
  - `blockedAgentFinalText()` 生成最终回复阻断文案。
- `packages/core-agent/src/react-agent.ts`
  - 工具结果命中硬阻断时，记录为可恢复的工具失败，并继续 ReAct 循环。
  - 最终回复命中硬阻断时，返回 `safety_blocked`。
- `packages/core-agent/src/types.ts`
  - `AgentOutputSafetyPolicy.pii` 支持 `redact | block | allow`。
  - `AgentToolExecutionRecord` 支持 `blocked`。
  - `AgentToolFailureKind` 支持 `output_safety`。
  - 行为评估工具期望支持 `blocked`。

## 运行契约

默认策略仍是脱敏：

```ts
outputSafety: undefined
```

显式硬阻断：

```ts
outputSafety: { pii: 'block' }
```

工具结果被阻断时：

- `status = 'failed'`
- `failureKind = 'output_safety'`
- `retryable = true`
- `blocked = true`
- `redactionReasons` 保留命中原因，如 `email`、`phone`、`sensitive_key`
- `resultPreview` 只包含安全 JSON：`tool_result_blocked_by_output_safety`
- 下一轮模型上下文只看到安全错误，不看到原始工具结果或脱敏后的行级结果

最终回复被阻断时：

- `AgentRunResult.status = 'safety_blocked'`
- `finalText` 使用默认或配置的阻断文案
- session 中的 assistant message 不包含原始 PII

## 开源方案评估

本切片没有引入新依赖。评估结论：

- Microsoft Presidio、Guardrails、LangChain middleware 等方案适合更完整的 DLP/LLM guardrail 体系，但会引入额外运行时、模型/规则配置和打包复杂度。
- 当前目标是让 DBAgent 的 ReAct 工具链具备明确的安全状态机和可恢复语义，重点是与 `AgentToolExecutionRecord`、checkpoint、审计日志、行为评估集成。
- 因此本切片采用自研轻量启发式实现，先稳定核心契约；后续可以把成熟 DLP 作为 adapter 接入 `output-safety.ts`。

## 测试覆盖

- `packages/core-agent/test/output-safety.test.ts`
  - 验证硬阻断模式会标记 `blocked`，并仍移除原始敏感值。
- `packages/core-agent/test/react-agent.test.ts`
  - 验证不安全工具结果被阻断后不会进入下一轮模型上下文。
  - 验证 Agent 能根据安全错误改写为聚合查询并完成任务。
  - 验证最终回复包含 PII 时返回 `safety_blocked`。
- `packages/core-agent/test/behavior-evaluation.test.ts`
  - 验证行为评估支持 `blocked` 期望。
- `packages/core-tools/test/agent-rag-business-scenario.test.ts`
  - 使用电商/客户业务 fixture 验证“错误行级查询 -> 阻断 -> 聚合查询恢复”的用户级流程。

## 已知边界

- 当前敏感识别仍是启发式，不替代企业级 DLP。
- 默认仍为 `redact`，硬阻断需要显式开启。
- 工具调用参数本身仍按脱敏副本进入 session；真实执行使用原始 tool call，避免清洗 SQL 影响执行语义。
- 后续应把 schema RAG 的字段语义、数据库注释、连接级策略纳入判定。
