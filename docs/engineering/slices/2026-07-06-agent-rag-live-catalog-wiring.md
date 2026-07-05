# 2026-07-06 Agent/RAG Live Gate 接入 Eval Suite Catalog

## 背景

Agent/RAG live gate 之前在测试文件中内联定义 suite。这样可以跑通真实 SiliconFlow 验收，但 suite 来源和官方插件/工作区 manifest 体系脱节。现在已有 `loadAgentEvalSuiteCatalog()`，live gate 应改为通过 catalog 读取 suite，避免后续发布门禁和工作区自定义验收继续分叉。

## 本轮实现

- `packages/core-tools/test/agent-rag-business-scenario.test.ts`
  - 引入 `loadAgentEvalSuiteCatalog()`。
  - 新增 `loadLiveAgentRagSuite()`。
  - 默认从官方插件 catalog 读取 `official.agent-rag.business-readonly`。
  - 支持 `DBAGENT_AGENT_RAG_SUITE_ID` 选择 suite。
  - 支持 `DBAGENT_AGENT_RAG_EVAL_WORKSPACE` 加载工作区 `.dbagent/evals/*.json`。
  - 增加默认非 live 测试，验证 live gate 使用的官方 suite 可从 catalog 读取。

## 安全边界

- 默认测试仍不调用真实 LLM。
- `DBAGENT_RUN_AGENT_RAG_LIVE=1` 且存在 `TEST_SILICONFLOW_API_KEY` 或 `DBAGENT_LLM_API_KEY` 时才执行真实 SiliconFlow。
- suite manifest 仍不承载 provider、model、API key、数据库密码或连接串。
- 工作区 suite 只在显式设置 `DBAGENT_AGENT_RAG_EVAL_WORKSPACE` 时加载。

## 验收

- `vitest run packages/core-tools/test/agent-rag-business-scenario.test.ts packages/core-tools/test/agent-eval-suite-catalog.test.ts` 通过。
- `pnpm --filter @dbagent/core-tools typecheck` 通过。
- `scripts/run-agent-rag-live-tests.mjs` 通过，真实 SiliconFlow `deepseek-ai/DeepSeek-V4-Pro` 调用成功，报告写入 `tmp/agent-rag-live-report`。

## 后续

- 将 catalog 查询能力下沉到服务层，供发布门禁脚本和后续 typed IPC 共用。
- 让 live report 记录 suite source metadata，方便排查官方 suite 与工作区 suite 的差异。
