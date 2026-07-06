# Agent/RAG Live Gate 统一 Run Service 切片

## 背景

Agent/RAG live gate 已经能通过真实 SiliconFlow `deepseek-ai/DeepSeek-V4-Pro` 调用 `search_schema` 和 `query_database`。上一轮新增了 `AgentEvalSuiteRunService`，但 live 测试入口仍在测试文件里手工组合 catalog 和 runner。

本切片把 live gate 迁移到统一 run service，确保发布门禁、真实模型测试、工作区 suite 选择和报告来源写入走同一条后端路径。

## 实现范围

- `packages/core-tools/src/agent-eval-suite-runner.ts`
  - 新增 `reportRun` 可选项，用于覆盖报告里的 run metadata。
- `packages/core-tools/src/agent-eval-suite-run-service.ts`
  - 透传 `reportRun` 到 runner。
- `packages/core-tools/test/agent-rag-business-scenario.test.ts`
  - SiliconFlow live gate 改为通过 `AgentEvalSuiteRunService.run()` 执行。
  - live gate 仍支持 `DBAGENT_AGENT_RAG_SUITE_ID` 和 `DBAGENT_AGENT_RAG_EVAL_WORKSPACE`。
  - live 报告显式断言 `run.live=true`。
- `packages/core-tools/test/agent-eval-suite-run-service.test.ts`
  - 增加 `reportRun` 覆盖断言，确认 service 能把 live/commit 等运行元数据写入报告。

## 设计边界

- `reportRun` 只影响报告元数据，不改变 Agent 执行参数。
- provider、model、mode、allowedTools 仍由 `baseRun` 控制。
- suite 选择仍由 catalog service 负责。
- 真实依赖门禁仍由 run service 控制。

## 开源方案评估

本切片不新增依赖。该能力属于内部 release gate 编排，不需要引入 OpenAI Evals、promptfoo 或 LangSmith。后续如果引入第三方 eval 平台，应继续通过 adapter 调用 `AgentEvalSuiteRunService`，避免绕过真实依赖门禁和 suite source 记录。

## 测试

- 默认测试：
  - `agent-eval-suite-run-service.test.ts` 使用真实临时工作区 suite 验证 `reportRun` 覆盖。
  - `agent-rag-business-scenario.test.ts` 默认 scripted provider 路径不消耗真实模型。
- 真实模型门禁：
  - `scripts/run-agent-rag-live-tests.mjs` 仍是显式入口。
  - 设置 `DBAGENT_RUN_AGENT_RAG_LIVE=1` 后，live case 通过 run service 执行。
  - 报告目录继续写入 `manifest.json`、`results.json`、`report.md`、`reports.json` 和 `run.json`。

## 后续

- 后续主进程或 release CLI 可以直接调用 `AgentEvalSuiteRunService`。
- 可把 PostgreSQL gate 也逐步迁移到 run service，统一真实依赖门禁。
