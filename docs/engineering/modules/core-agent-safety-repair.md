# core-agent 安全预检与工具失败修复契约

## 目标

本模块为 Agent 运行时增加两类后端能力：

- 在调用模型和工具前识别直接提取、解密、导出敏感个人信息的任务，并以 `safety_blocked` 结束运行。
- 为工具失败记录稳定分类和可重试标记，让 Agent、评测和后续恢复逻辑能区分 SQL 可修复错误、超时、依赖瞬断、权限问题和工具缺失。

当前阶段仍保持前端 UI 冻结，不接入多数据库，不引入新的重型 Agent 框架。

## 代码入口

- `packages/core-agent/src/task-safety.ts`
  - `assessAgentTaskSafety()`：任务级安全预检。
  - 默认阻止直接导出、列出、解密、显示手机号、邮箱、身份证、密码、token、密钥等敏感字段。
  - 允许聚合、脱敏、分布、趋势类分析；但如果同一请求仍要求“明文/解密/plaintext/decrypt”，继续阻止。
- `packages/core-agent/src/tool-failure-classifier.ts`
  - `classifyAgentToolFailure()`：根据工具错误文本输出 `failureKind` 和 `retryable`。
- `packages/core-agent/src/react-agent.ts`
  - 在模型调用和工具执行前执行安全预检。
  - 阻止时写入会话消息、审计日志，并返回 `status: 'safety_blocked'`。
  - 工具失败时把 `failureKind` 和 `retryable` 写入 `AgentToolExecutionRecord` 与审计事件。
- `packages/core-agent/src/types.ts`
  - 新增 `AgentTaskSafetyPolicy`。
  - 新增 `AgentToolFailureKind`。
  - `AgentRunStatus` 新增 `safety_blocked`。

## 运行契约

安全预检命中时：

- 不调用 LLM provider。
- 不启动用量轮次。
- 不执行任何工具。
- 会保存一条中文拒绝消息，说明可以改为脱敏统计、分布分析或合规检查。
- 审计日志以 `run_started` 和 `run_finished` 记录，最终状态为 `safety_blocked`。

工具失败分类当前包括：

- `sql_repairable`：字段不存在、表不存在、语法错误、空 SQL、多语句限制等，通常可由 Agent 修复 SQL 后重试。
- `timeout`：工具超时或用户侧等待超时，可重试。
- `transient_dependency`：网络断开、连接重置、序列化冲突、临时依赖不可用，可重试。
- `permission`：权限拒绝、未确认、连接策略禁止，不自动重试。
- `tool_unavailable`：工具未注册或不可用，不自动重试。
- `validation`：参数非法或缺少必填字段，不自动重试。
- `unknown`：无法稳定判断，不自动重试。

## 业务评测覆盖

`packages/core-tools/test/agent-rag-business-scenario.test.ts` 增加两类确定性用户场景：

- 客户明文手机号导出请求：在模型和数据库工具前直接阻止，验证不触发 `search_schema`、`query_database`、`execute_sql`。
- SQL 字段错误修复：先执行错误 SQL，收到字段不存在错误后，Agent 重新检索并执行修复后的业务查询，验证失败记录为 `sql_repairable` 且 `retryable: true`。

这些测试使用电商和流量分析业务语境，目标是验证用户真实工作流，而不是只验证内部函数。

## 已知边界

- 当前安全预检是启发式规则，不替代企业级 DLP 或字段级权限系统。
- 当前只在任务入口拦截敏感信息导出，尚未对工具返回结果做逐行 PII 脱敏。
- 当前 live LLM 门禁已有基础 Agent/RAG 覆盖，但还需要扩展负例安全集和真实模型自修复集。
- 当前工具错误分类基于错误文本，后续应优先接入结构化数据库错误码和工具错误码。

## 后续开发建议

下一轮优先补结果级安全层：

- 对工具返回结果建立字段级敏感标记。
- 在 Agent final text 生成前进行安全摘要和脱敏检查。
- 把 live SiliconFlow 测试扩展为包含 PII 拒绝、SQL 修复、工具瞬断恢复的门禁套件。
