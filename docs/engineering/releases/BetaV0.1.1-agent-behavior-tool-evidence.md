# BetaV0.1.1 Agent 行为评估工具证据

## 范围

本版本继续强化后端 Agent/RAG 验收能力，不涉及前端 UI。

新增能力：

- Agent 工具执行记录新增脱敏参数快照。
- Agent 行为评估支持工具参数、工具结果、调用次数、最终回答禁止片段等断言。
- Agent/RAG 业务场景测试开始验证工具调用是否真正使用了正确 schema 与 SQL 证据。
- 评估报告输出脱敏工具证据，便于后续用户级验收和 release smoke 归档。

## 验证

已完成窄范围验证：

- `vitest run packages/core-agent/test/behavior-evaluation.test.ts packages/core-agent/test/react-agent.test.ts packages/core-tools/test/agent-rag-business-scenario.test.ts`
- `pnpm --filter @dbagent/core-agent --filter @dbagent/core-tools typecheck`

完整质量门禁仍需在提交前执行。

## 已知限制

- 当前评估器是确定性字符串检查，不做 SQL AST 或自然语言事实判定。
- 真实 LLM live 测试仍通过环境变量显式开启，不作为默认测试套件强制运行。
- 后续应把高成本 eval suite 做成官方 Agent/RAG Eval 插件。
