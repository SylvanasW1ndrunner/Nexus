# Agent Eval Suite Run Service 切片

## 背景

Agent/RAG 评测链路已经具备 manifest、工作区 loader、官方插件 registry、catalog、catalog service 和 runner。后续发布门禁、主进程 IPC、官方插件入口需要一个统一的“从 catalog 选择 suite 后执行”的后端服务，否则调用方会直接拼接 catalog 和 runner，导致真实依赖门禁、报告来源和错误处理分散。

本切片新增 `AgentEvalSuiteRunService`，把 suite 选择、真实依赖门禁和 runner 调用收敛到 `core-tools`。

## 实现范围

- 新增 `packages/core-tools/src/agent-eval-suite-run-service.ts`。
- 导出 `AgentEvalSuiteRunService`。
- 支持：
  - 按 `suiteId` 从 `AgentEvalSuiteCatalogService` 获取 suite。
  - 通过 `catalog` 配置传入官方插件启用项和工作区路径。
  - 执行前检查真实依赖门禁。
  - 自动把 official/workspace source 写入报告。
  - 透传 `reportStorePath`、`generatedAt`、`reportId`、`stopOnFirstFailure`。

## 真实依赖门禁

- `environment: postgres` 默认拒绝执行，必须显式传入 `allowPostgresSuites: true`。
- `environment: llm-live` 默认拒绝执行，必须显式传入 `allowLiveSuites: true`。
- 拒绝发生在 Agent 调用前，避免误触发真实 PostgreSQL、真实 LLM 或报告写入。

## 明确不做

- 不创建 Agent 实例。
- 不读取 provider、model、API key、数据库密码或连接串。
- 不创建数据库 fixture。
- 不直接接入 Electron、preload、renderer 或最终 UI。
- 不代替 runner 做行为评估。

## 开源方案评估

本切片没有新增依赖。可借鉴的 OpenAI Evals、promptfoo、LangSmith/LangChain eval 更适合完整评测框架、云端 tracing 或 provider 回归测试；本切片只是 DBAgent 内部 catalog-to-runner 编排服务。自建轻量服务能保持：

- core 包不依赖云端服务。
- Electron 打包无新增体积和 native 风险。
- 真实依赖门禁符合 DBAgent 的权限模型。
- 未来第三方 eval 框架仍可在官方插件 adapter 层接入。

## 测试

新增 `packages/core-tools/test/agent-eval-suite-run-service.test.ts`，覆盖：

- 从真实临时工作区 `.dbagent/evals/*.json` 读取 suite 并执行。
- 自动写入 workspace suite source 到报告。
- `postgres` suite 未显式授权时拒绝执行，且不调用 Agent。
- 显式打开 PostgreSQL 门禁后执行 `postgres` suite。
- `llm-live` suite 未显式授权时拒绝执行，且不调用 Agent。
- suite 不存在时返回明确错误。

## 后续

- 主进程服务可以基于该 service 暴露发布验收或设置页测试入口。
- `pnpm test:agent-rag-live` 后续可以逐步改为通过该 service 统一执行，减少测试脚本内的 catalog/runner 拼接逻辑。
- 插件市场后续可以把官方 eval suite 作为官方插件能力展示，但执行仍必须走该 service 的真实依赖门禁。
