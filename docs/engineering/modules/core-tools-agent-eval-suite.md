# core-tools Agent/RAG Eval Suite Runner

## 目标

上一阶段 `core-agent` 已经具备工具参数、工具结果和最终回答的结构化评估能力。本模块把它提升为可运行的后端套件能力：

- 批量运行 Agent 业务用例。
- 对每个真实 run 执行行为评估。
- 生成脱敏验收报告。
- 可选写入本地报告索引。
- 作为后续官方 “Agent/RAG Eval” 插件的后端底座。

该能力不依赖最终前端 UI，也不启动网络市场。

## 代码入口

- `packages/core-tools/src/agent-eval-suite-runner.ts`
  - `runAgentBehaviorEvaluationSuite(options)`
  - `AgentEvalSuite`
  - `AgentEvalSuiteCase`
  - `AgentEvalSuiteRunResult`
- `packages/core-tools/src/official-plugin-registry.ts`
  - 新增默认关闭的 `official.agent-rag-eval` manifest。
- `packages/core-tools/test/agent-eval-suite-runner.test.ts`
  - 套件运行、报告落盘、失败提前停止、空套件错误。
- `packages/core-tools/test/agent-rag-business-scenario.test.ts`
  - 默认 scripted provider 业务夹具验收和 SiliconFlow live Agent/RAG 验收均通过 runner 执行。
  - live 入口继续输出 `manifest.json`、`results.json`、`report.md` 和 `reports.json`。

## 运行合同

`runAgentBehaviorEvaluationSuite()` 接收：

- `agent`：提供 `run(options)` 的 Agent 实例或 adapter。
- `suite`：业务用例集合，每个 case 使用 `AgentBehaviorEvaluationCase` 描述验收规则。
- `baseRun`：公共 Agent 运行参数，例如 provider、model、mode、迭代数。
- `reportStorePath`：可选报告索引路径。
- `stopOnFirstFailure`：可选，失败后立即停止，适合 release gate。

每个 suite case 可以通过 `run` 覆盖部分运行参数，例如更高的超时、更小的迭代上限或不同模式。最终 `userMessage` 固定来自 `case.userTask`，避免评估定义和真实任务输入脱节。

`AgentBehaviorToolExpectation` 支持 `caseSensitive: false`。该选项只影响单个工具期望里的 `argumentIncludes`、`argumentExcludes`、`resultIncludes` 和 `resultExcludes`。默认仍保持大小写敏感；live LLM 场景可以对 SQL 关键字、枚举值等开启大小写不敏感匹配，避免 `SELECT`/`select` 这类无业务差异导致真实验收误失败。

## 官方插件边界

`official.agent-rag-eval` 当前默认关闭，且不贡献 Agent tool。原因：

- Eval runner 是发布/验收能力，不应默认暴露给模型调用。
- 它可能触发真实 LLM、真实 PostgreSQL 或写报告文件，执行入口应由测试脚本、主进程服务或后续设置页显式触发。
- 真正进入插件市场后，插件可以声明 suite、报告目录、真实依赖门控和权限说明；core-tools 只保留稳定 runner 合同。

Manifest 信息：

- `category: eval`
- `capabilities: agent-eval-suite, tool-evidence-report, release-quality-gate`
- `permission: eval.report.write`
- `resourceScopes: agent.session, eval.report`
- `enabledByDefault: false`

## 开源方案评估

可借鉴对象：

- OpenAI Evals：适合模型行为批量评测，但 runner 与 DBAgent 工具权限、脱敏报告、工作区路径和发布门禁不直接匹配。
- promptfoo：适合 prompt/provider 回归测试，但仍需 adapter 才能表达 DBAgent 的工具参数、工具结果和权限证据。
- LangSmith/LangChain eval：适合 tracing 和云端可视化，但当前 core 包不能依赖外部云服务，也不能把 tracing 类型暴露为稳定合同。

本切片选择自建轻量 runner，原因：

- 无新增依赖，降低打包和离线风险。
- 直接复用 `core-agent` 的脱敏报告合同。
- 可在默认测试、PostgreSQL 门控和 SiliconFlow live 门控中统一使用。

后续如果接入第三方 eval 框架，应放在官方插件 adapter 层，不进入 `packages/shared` 或核心 Agent 合同。

## 测试覆盖

- 成功套件：
  - Agent 被真实调用。
  - case-level run override 生效。
  - 工具参数、工具结果和最终回答被评估。
  - 报告写入本地 store。
  - 明文 API key 不进入报告。
- 默认业务夹具套件：
  - 使用 scripted provider、fake PostgreSQL driver 和真实 `ReactAgent` 调用路径。
  - 验证 `search_schema`、`query_database`、最终回答、实际 SQL 执行记录和临时 report store。
- PostgreSQL 套件：
  - `pnpm test:postgres` 会创建真实 PostgreSQL 业务表、抽取 catalog、索引 RAG，并通过 `runAgentBehaviorEvaluationSuite()` 执行 Agent 工具链。
  - 报告 run metadata 标记 `postgres: true`，并验证临时 report store 摘要。
- live 套件：
  - `scripts/run-agent-rag-live-tests.mjs` 设置 `DBAGENT_RUN_AGENT_RAG_LIVE=1` 后，真实 SiliconFlow `deepseek-ai/DeepSeek-V4-Pro` case 会通过 `runAgentBehaviorEvaluationSuite()` 执行。
  - live 报告目录仍兼容旧入口：`tmp/agent-rag-live-report` 下写入 `manifest.json`、`results.json`、`report.md`、`reports.json` 和 `run.json`。
  - live SQL 参数断言对 SQL 关键字使用 `caseSensitive: false`，仍要求 `query_database` 成功执行并返回 `paid_search` 等业务结果。
- 失败套件：
  - `stopOnFirstFailure` 只运行第一个失败用例。
- 输入错误：
  - 空 suite 在调用 Agent 前失败。

## 已知边界

- 当前 runner 串行执行 case，后续可增加并发，但要先处理 provider rate limit 和数据库 fixture 隔离。
- 当前 suite 本身不持久化，后续可由官方插件或工作区文件提供 suite manifest。
- 当前不内置 LLM judge；自然语言充分性仍依赖 case 中的确定性断言或后续人工/模型评审。
