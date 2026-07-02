# 2026-07-02 Agent/RAG live 验收接入 Suite Runner

## 背景

上一切片新增了 `runAgentBehaviorEvaluationSuite()`，但真实 SiliconFlow live 验收仍然手写 Agent run、手写评估和报告生成。这样 runner 只被单元测试证明，未覆盖最重要的真实 LLM 场景。

## 本轮实现

- `packages/core-tools/test/agent-rag-business-scenario.test.ts`
  - SiliconFlow live case 改为调用 `runAgentBehaviorEvaluationSuite()`。
  - suite case 保留 `search_schema`、`query_database`、工具参数、工具结果、最终回答禁止片段等验收规则。
  - `query_database` 的 SQL 关键字断言使用 `caseSensitive: false`，避免真实模型输出 `SELECT` 时因大小写差异误判；业务结果仍要求包含 `paid_search`。
  - `stopOnFirstFailure: true`，失败时立即停止。
  - 继续写入 `tmp/agent-rag-live-report` 下的报告文件，保持脚本行为兼容。
- `packages/core-agent/src/behavior-evaluation.ts`
  - `AgentBehaviorToolExpectation` 新增局部大小写匹配开关，默认保持大小写敏感。
  - 增加单元测试覆盖 live SQL 常见的大小写差异。

## 边界

- 不改变默认测试：没有 `DBAGENT_RUN_AGENT_RAG_LIVE=1` 和测试 key 时 live case 仍跳过。
- 不触碰 UI。
- 不改变 SiliconFlow provider。
- 不新增依赖。

## 验收

- `@dbagent/core-agent` lint、typecheck、test 通过。
- `@dbagent/core-tools` lint、typecheck、test 通过。
- `scripts/run-agent-rag-live-tests.mjs` 已真实调用 SiliconFlow 并通过，报告写入 `tmp/agent-rag-live-report`。
- 报告仍由环境变量 `DBAGENT_AGENT_RAG_REPORT_DIR` 控制输出目录。

## 后续

- 把 PostgreSQL fixture case 也整理成 suite runner 入口。
- 支持从工作区或官方插件 manifest 加载 suite 定义。
