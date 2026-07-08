# 2026-07-08 Agent 安全预检与 SQL 修复契约

## 范围

本切片只处理后端 Agent 运行时，不开发前端 UI，不开发多数据库。

实现内容：

- 增加任务级 PII 导出安全预检。
- 增加 `safety_blocked` 运行状态。
- 增加工具失败分类和可重试标记。
- 把 SQL 可修复错误暴露给 Agent 行为评测。
- 增加确定性业务场景测试，覆盖 PII 拒绝和 SQL 错误修复。

## 验收标准

- 直接导出或解密客户手机号、邮箱、身份证等敏感信息的请求必须在模型和工具前被阻止。
- 聚合、脱敏、分布类分析可以继续执行。
- 如果请求包含“统计”但仍要求“明文/解密”，必须阻止。
- SQL 字段不存在等错误必须记录为 `sql_repairable`，并标记可重试。
- 超时、瞬断、权限拒绝、工具缺失、参数校验错误必须有稳定分类。
- 评测报告能判断 Agent 是否先失败再修复，而不是只看最终回答。

## 测试结果

已完成本切片相关验证：

- `tsc -p packages/core-agent/tsconfig.json --noEmit`
- `tsc -p packages/core-tools/tsconfig.json --noEmit`
- `eslint packages/core-agent packages/core-tools`
- `vitest run packages/core-agent/test/task-safety.test.ts packages/core-agent/test/tool-failure-classifier.test.ts packages/core-agent/test/react-agent.test.ts packages/core-tools/test/agent-rag-business-scenario.test.ts --passWithNoTests`
- `node scripts/run-postgres-tests.mjs`

PostgreSQL 门禁覆盖真实本地 PostgreSQL、桌面取消查询、认证 PostgreSQL 存储、core-tools 真实业务 fixture。

## 决策

本切片没有引入 LangChain、LangGraph、Guardrails 等框架。原因是当前需求是稳定运行契约和可测试边界，直接把轻量规则放进 `core-agent` 更适合打包、审计和单元测试。后续如果接入更完整的安全/评测框架，应放在官方插件或 adapter 层，不让第三方类型污染核心包契约。

## 风险

- 启发式敏感信息识别会存在误判和漏判。
- 结构化错误码覆盖不足时，工具失败分类仍依赖错误文本。
- live LLM 自修复用例还需要继续扩展，当前主要通过确定性 scripted provider 验证行为链路。
