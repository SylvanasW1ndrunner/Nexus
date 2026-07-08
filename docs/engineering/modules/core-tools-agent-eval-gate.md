# core-tools Agent 评估发布门禁

## 目标

本模块把 Agent/RAG 验收从“跑完测试并生成报告”推进为“可机器判定的发布门禁”。它服务于当前后端优先开发阶段，不依赖最终前端 UI。

## 代码入口

- `packages/core-tools/src/agent-eval-gate.ts`
- `packages/core-tools/src/agent-eval-suite-run-service.ts`
- `packages/core-tools/test/agent-eval-gate.test.ts`
- `packages/core-tools/test/agent-eval-suite-run-service.test.ts`
- `packages/core-tools/test/agent-rag-business-scenario.test.ts`

## 门禁策略

`evaluateAgentEvalGate()` 接收 suite 运行结果、catalog entry、suite source 和可选策略，输出：

- `passed`：是否通过发布门禁。
- `failures`：会阻断发布的明确原因。
- `warnings`：不直接阻断，但需要关注的失败用例或元数据差异。
- `metrics`：总用例数、通过数、失败数、通过率、环境、来源、是否 live、是否 PostgreSQL、报告是否保存、是否 readonly。

当前支持的策略包括：

- 最小用例数。
- 最低通过率。
- 最大失败用例数。
- 必须匹配的 suite environment。
- 必须匹配的 suite source。
- 必须是 live LLM。
- 必须是 PostgreSQL-backed。
- 必须保存评估报告。
- 必须全部 readonly。
- 必须观测到指定工具。
- 禁止观测到指定工具。

## 有效 readonly 证据

readonly 门禁不能只看 workspace manifest 是否显式写了 `run.mode='readonly'`。真实发布运行中，调用方可能通过 `baseRun.mode='readonly'` 统一约束整个 suite，同时 manifest 只描述业务用例和允许工具。

因此 `AgentEvalSuiteRunService` 会向 gate 传入 `effectiveReadonlyOnly`：

- 如果 catalog entry 已经是 `readonlyOnly=true`，直接通过 readonly 证据。
- 如果 `baseRun.mode !== 'readonly'`，不能视为只读。
- 如果 `baseRun.mode='readonly'`，且 suite 内没有 case 覆盖为非只读模式，则视为有效只读。

该规则避免放宽安全门禁，同时支持工作区 suite 不携带 provider、model、secret 等运行信息。

## Run Service 集成

`AgentEvalSuiteRunService.run()` 新增可选参数：

- `gate`：门禁策略。
- `failOnGateFailure`：为 `true` 时，门禁失败直接抛出 `AgentEvalSuiteGateError`。

默认不传 `gate` 时行为不变，保证已有调用方兼容。

## Live Gate 集成

`agent-rag-business-scenario.test.ts` 中的 SiliconFlow live 和 SiliconFlow + PostgreSQL 组合门控已接入 gate：

- live LLM gate 要求 `live=true`、官方 suite、readonly、保存报告，并观测到 `search_schema` 和 `query_database`。
- live PostgreSQL gate 要求 `live=true`、`postgres=true`、workspace suite、readonly、保存报告，并观测到 `search_schema` 和 `query_database`。
- 两类 gate 都禁止观测到 `execute_sql`。

当设置 `DBAGENT_AGENT_RAG_REPORT_DIR` 时，测试会额外写入 `gate.json`，供发布流程或人工验收读取。

## 边界

- 本模块不直接调用 LLM、不直接连接 PostgreSQL、不创建测试数据，只负责判断已有 suite run 的证据是否足够。
- 默认测试不会消耗 SiliconFlow API，也不会要求网络。
- 真实 live gate 由 `pnpm test:agent-rag-live` 或 `scripts/run-agent-rag-live-tests.mjs` 显式触发。
- gate 只基于当前报告和工具执行证据判断，不替代业务正确性断言；业务数值正确性仍应写在 eval case 的 `toolExpectations` 和 `finalTextIncludes` 中。

## 测试

默认测试覆盖：

- 严格发布策略通过。
- 缺少真实依赖标记、报告、readonly、工具调用或通过率不足时失败。
- run service 能附加 `gate` 决策。
- `failOnGateFailure=true` 时抛出 `AgentEvalSuiteGateError`。
- `baseRun.mode='readonly'` 且 suite 未覆盖模式时，作为有效 readonly 证据。
- live 测试默认跳过，但已接入 gate 参数和 `gate.json` 输出。
