# BetaV0.1.1 Agent Eval 报告 Suite Source

## 范围

本切片为 Agent/RAG eval 报告增加 suite source 元数据。报告可以区分 suite 来自官方插件、工作区 manifest 还是手动构造，便于后续发布门禁、插件市场和用户自定义验收排查。

## 主要变更

- `AgentBehaviorEvaluationReportInput` 增加可选 `suiteSource`。
- 报告对象、`manifest.json`、`results.json` 和 `report.md` 输出 `suiteSource`。
- `runAgentBehaviorEvaluationSuite()` 支持接收并传递 `suiteSource`。
- Agent/RAG live gate 会把 catalog entry 的 source 传入 runner。

## 验证

- `vitest run packages/core-agent/test/behavior-evaluation.test.ts packages/core-tools/test/agent-eval-suite-runner.test.ts packages/core-tools/test/agent-rag-business-scenario.test.ts`
- `pnpm --filter @dbagent/core-agent typecheck`
- `pnpm --filter @dbagent/core-tools typecheck`
- `scripts/run-agent-rag-live-tests.mjs`，真实 SiliconFlow 报告已确认 `manifest.json`、`results.json`、`report.md` 包含 `official.agent-rag-eval` source

## 已知边界

- `run.json` 暂未记录 suite source；当前报告主体文件已经记录。
- 该字段仅用于追踪，不参与权限判断。
