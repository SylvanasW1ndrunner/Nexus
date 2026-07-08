# 2026-07-08 Agent 输出安全层

## 范围

本切片完成 Agent 工具结果、最终回复、流式持久化、评测报告和报告 store 的结果级脱敏。

不包含：

- 前端 UI。
- 多数据库。
- 企业级 DLP。
- 结果级 hard block。

## 验收标准

- 工具返回邮箱、手机号、`phone_enc` 时，不得进入 session tool message、下一轮模型上下文、tool execution preview、audit、checkpoint、评测报告。
- 模型最终回复包含邮箱、手机号、`phone_enc=value` 时，`finalText` 和 assistant message 必须脱敏。
- 流式 text-delta 和 finish response 落盘时必须脱敏。
- 行为评测报告和报告 store 即使收到历史未净化结果，也不能持久化原始敏感值。
- 聚合字段如 `customer_count`、`email_domain`、`phone_prefix_masked` 必须保留。
- 输出脱敏证据必须可审计：`redacted` 和 `redactionReasons`。

## 测试结果

已运行：

- `tsc -p packages/core-agent/tsconfig.json --noEmit`
- `tsc -p packages/core-tools/tsconfig.json --noEmit`
- `eslint packages/core-agent packages/core-tools`
- `vitest run packages/core-agent/test/output-safety.test.ts packages/core-agent/test/react-agent.test.ts packages/core-agent/test/behavior-evaluation.test.ts packages/core-agent/test/stream-store.test.ts packages/core-agent/test/evaluation-report-store.test.ts --passWithNoTests`
- `vitest run packages/core-tools/test/agent-rag-business-scenario.test.ts --passWithNoTests`
- `vitest run packages/core-agent/test --passWithNoTests`
- `vitest run packages/core-tools/test --passWithNoTests`
- `node scripts/run-postgres-tests.mjs`

全包 core-agent、core-tools 和本地真实 PostgreSQL 门禁均已通过。

## 开源方案评估

本切片没有引入新依赖。原因：

- 需求是本地、可打包、可审计的输出清洗契约。
- 引入重型 DLP/PII 框架会增加 native/模型/规则包依赖，不利于当前桌面应用打包。
- 当前实现集中在 `core-agent`，后续可以在官方插件中接入更强的 DLP 适配器，但核心包先保持轻量。

## 后续建议

下一块可以做“结构化结果级安全策略”：

- 基于 RAG schema semanticType 标记敏感字段。
- 对敏感字段命中时支持 `redact`、`summarize`、`block` 三种策略。
- 将 hard block 的语义接入 Agent loop，让 Agent 能改写查询或要求用户确认。
