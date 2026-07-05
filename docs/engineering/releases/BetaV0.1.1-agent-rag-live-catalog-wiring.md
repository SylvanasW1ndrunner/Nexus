# BetaV0.1.1 Agent/RAG Live Gate 接入 Catalog

## 范围

本切片把 Agent/RAG live gate 从内联 suite 改为通过统一 eval suite catalog 读取 suite。默认使用官方 `official.agent-rag.business-readonly`，并预留工作区 suite 加载入口。

## 主要变更

- live gate 使用 `loadAgentEvalSuiteCatalog()`。
- 默认 suite：`official.agent-rag.business-readonly`。
- 可通过 `DBAGENT_AGENT_RAG_SUITE_ID` 选择 catalog 中的 suite。
- 可通过 `DBAGENT_AGENT_RAG_EVAL_WORKSPACE` 加载工作区 `.dbagent/evals/*.json`。
- 默认测试新增 catalog wiring 验证，不需要真实 LLM key。

## 验证

- `vitest run packages/core-tools/test/agent-rag-business-scenario.test.ts packages/core-tools/test/agent-eval-suite-catalog.test.ts`
- `pnpm --filter @dbagent/core-tools typecheck`
- `scripts/run-agent-rag-live-tests.mjs`，真实 SiliconFlow `deepseek-ai/DeepSeek-V4-Pro` 通过，报告写入 `tmp/agent-rag-live-report`

## 已知边界

- 当前 live report 还未记录 suite source metadata。
- 工作区 suite 如果要在 live gate 中运行，仍需与当前业务 fixture 的工具名、connectionId 和结果断言保持一致。
