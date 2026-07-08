# core-agent 输出安全层

## 目标

上一轮已经实现任务入口安全预检，可以在模型和工具执行前阻止直接导出敏感个人信息的请求。本模块补齐结果级安全层，处理另一类真实风险：用户任务本身是合法汇总分析，但工具结果或模型最终回复意外带出邮箱、手机号、加密字段、token 或密钥。

当前能力仍只在后端 core 层实现，不开发前端 UI，不开发多数据库。

## 代码入口

- `packages/core-agent/src/output-safety.ts`
  - `sanitizeAgentOutputValue()`：清洗对象、数组、工具结果和结构化报告。
  - `sanitizeAgentOutputText()`：清洗模型文本、流式文本和错误/报告文本。
  - 默认替换文本为 `[REDACTED_PII]`。
- `packages/core-agent/src/react-agent.ts`
  - 模型最终文本进入 session、checkpoint、audit 和 `finalText` 前先脱敏。
  - 工具成功结果进入 tool message、下一轮模型上下文、审计和执行记录前先脱敏。
  - assistant message 中保存的 toolCalls 参数也使用脱敏副本，真实执行仍使用原始 toolCall。
- `packages/core-agent/src/stream-store.ts`
  - 流式 text delta、tool-call event、finish response 落盘前执行同一安全清洗。
- `packages/core-agent/src/behavior-evaluation.ts`
  - 评测报告生成前再次清洗，避免历史未净化结果写入报告。
- `packages/core-agent/src/evaluation-report-store.ts`
  - 报告保存和读取时兜底清洗，避免持久化层成为泄漏点。

## 规则

默认脱敏以下内容：

- 邮箱地址。
- 原始手机号或长数字电话。
- 身份证号。
- `phone`、`mobile`、`email`、`id_card`、`password`、`token`、`secret`、`api_key` 等敏感字段。
- `_enc`、`_encrypted`、`_cipher`、`phone_enc` 等加密字段。
- API key、Bearer token、数据库连接串密码。
- 常见 `ciphertext-*` 加密占位值。

允许保留以下聚合/脱敏信息：

- `customer_count`、`phone_count`、`email_domain`。
- `phone_prefix_masked`、`masked_phone` 等已脱敏字段。
- 城市、渠道、GMV、ROI、退款率等业务聚合维度。

## 运行契约

- 输出安全默认启用。
- `AgentRunOptions.outputSafety = false` 或 `{ pii: 'allow' }` 可用于可信离线诊断，但默认测试和业务路径不使用。
- 当前策略是结果级脱敏，不改变 Agent loop 状态，不返回 `safety_blocked`。
- `AgentToolExecutionRecord` 会记录：
  - `redacted: true`
  - `redactionReasons: ['email', 'phone', 'sensitive_key', ...]`
- 行为评测报告会展示脱敏后的证据，而不是原始行级数据。

## 测试覆盖

- `packages/core-agent/test/output-safety.test.ts`
  - 对象、文本、数字手机号、敏感字段名、聚合字段和禁用策略。
- `packages/core-agent/test/react-agent.test.ts`
  - 工具返回行级 PII 时，session、下一轮模型上下文、toolExecutions、audit、checkpoint、finalText 均不泄漏原始值。
- `packages/core-agent/test/stream-store.test.ts`
  - 流式增量文本和 finish response 落盘脱敏。
- `packages/core-agent/test/behavior-evaluation.test.ts`
  - 评测报告生成阶段兜底脱敏。
- `packages/core-agent/test/evaluation-report-store.test.ts`
  - 报告持久化层兜底脱敏。
- `packages/core-tools/test/agent-rag-business-scenario.test.ts`
  - 合法聚合请求下，数据库工具意外返回邮箱、手机号、`phone_enc`，最终业务评测仍只保留脱敏证据和聚合结果。

## 已知边界

- 当前策略是启发式脱敏，不替代企业级 DLP。
- 当前默认行为是 redact，不是 hard block；结果级阻止会改变 Agent loop 语义，应作为下一块独立模块处理。
- 对任意未知格式密文无法完全识别；后续应结合 schema RAG 的 `semanticType` 和数据库字段元数据做结构化判断。
- 当前没有新增第三方依赖，避免增加打包复杂度。
