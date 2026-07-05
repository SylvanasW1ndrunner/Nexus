# 2026-07-06 Agent Eval 报告记录 Suite Source

## 背景

Agent/RAG live gate 已改为通过 eval suite catalog 加载 suite。为了让报告具备可追溯性，报告本身需要记录 suite 来源：官方插件、工作区 manifest 或手动构造。否则 release gate 出现失败时，只能看到 suite id，无法确认它来自官方默认能力还是用户工作区自定义文件。

## 本轮实现

- `packages/core-agent/src/types.ts`
  - `AgentBehaviorEvaluationReportInput` 增加可选 `suiteSource`。
  - `AgentBehaviorEvaluationReport` 保留可选 `suiteSource`。
- `packages/core-agent/src/behavior-evaluation.ts`
  - `manifest.json` 输出 `suiteSource`。
  - `results.json` 输出 `suiteSource`。
  - `report.md` 输出 `Suite Source`。
- `packages/core-tools/src/agent-eval-suite-runner.ts`
  - `runAgentBehaviorEvaluationSuite()` 支持传入 `suiteSource`。
- `packages/core-tools/test/agent-rag-business-scenario.test.ts`
  - live gate 从 catalog entry 传递 `source` 到 runner。

## 安全边界

- `suiteSource` 只记录来源元数据，不包含 provider、model、API key、数据库密码或连接串。
- 报告构建仍走既有脱敏流程。
- 该字段不触发 suite 执行，也不改变 Agent 权限。

## 验收

- `vitest run packages/core-agent/test/behavior-evaluation.test.ts packages/core-tools/test/agent-eval-suite-runner.test.ts packages/core-tools/test/agent-rag-business-scenario.test.ts` 通过。
- `pnpm --filter @dbagent/core-agent typecheck` 通过。
- `pnpm --filter @dbagent/core-tools typecheck` 通过。
- `scripts/run-agent-rag-live-tests.mjs` 通过，真实 SiliconFlow 报告中的 `manifest.json`、`results.json`、`report.md` 均包含 `official.agent-rag-eval` source。

## 后续

- live report 的 `run.json` 可进一步记录所选 suite id 和 suite source，便于脚本级排查。
- 发布门禁服务接入 catalog 后，应在用户可见报告中展示 source label。
