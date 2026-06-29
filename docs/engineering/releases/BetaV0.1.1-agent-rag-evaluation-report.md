# BetaV0.1.1 - Agent/RAG 业务 eval 报告

## 变更

- 新增 Agent 行为评估报告构建能力：
  - `buildAgentBehaviorEvaluationReport()`
  - 输出 `manifest.json`、`results.json`、`report.md`
- 新增 `AgentBehaviorEvaluationReportStore`：
  - JSON 原子写入。
  - 按 `reportId` 读取。
  - 列表按生成时间倒序。
  - 损坏 JSON 自动降级为空列表。
- SiliconFlow live Agent/RAG 测试支持报告目录：
  - 默认 `tmp/agent-rag-live-report`。
  - 可通过 `DBAGENT_AGENT_RAG_REPORT_DIR` 覆盖。
- 报告默认脱敏 API key、Bearer token 和数据库连接串密码。

## 模块边界

- `core-agent` 只负责通用 Agent eval 合同、报告构建和报告 store。
- 业务 fixture、PostgreSQL、RAG 工具注册和 SiliconFlow live 调用仍保留在 `core-tools` 测试与脚本入口。
- 本次不改 renderer UI，不改变 `ReactAgent` 主循环，不新增第三方依赖。

## 验证

- `node .\node_modules\vitest\vitest.mjs run packages\core-agent\test\behavior-evaluation.test.ts packages\core-agent\test\evaluation-report-store.test.ts packages\core-tools\test\agent-rag-business-scenario.test.ts`
- `node .\node_modules\typescript\bin\tsc -p packages\core-agent\tsconfig.json --noEmit`
- `node .\node_modules\typescript\bin\tsc -p packages\core-tools\tsconfig.json --noEmit`

## 已知边界

- 普通 `pnpm test` 不写 eval 报告；live 脚本或显式报告目录才落盘。
- 当前报告不做 LLM judge，也不评价自然语言答案的事实充分性。
- 当前报告 store 使用本地 JSON，适合 beta 阶段；后续如果报告量增大，应迁移到 SQLite WAL。
- 报告展示页属于最终 UI 重建阶段，不在本切片范围。
