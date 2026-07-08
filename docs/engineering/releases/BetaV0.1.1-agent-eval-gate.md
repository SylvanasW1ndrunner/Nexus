# BetaV0.1.1 Agent/RAG 评估发布门禁

## 本轮变更

- 新增 Agent/RAG 评估 gate，支持机器可读的发布判定。
- `AgentEvalSuiteRunService` 可选择返回 gate 结果，或在 gate 失败时抛错。
- SiliconFlow live 和 SiliconFlow + PostgreSQL 组合门控已接入 gate。
- live 报告目录会额外写入 `gate.json`。
- readonly 证据改为按实际运行模式判定：`baseRun.mode='readonly'` 且 suite 未覆盖为非只读时，可作为有效只读证据。

## 用户价值

后续测试 Agent 和发布流程不需要只依赖人工阅读报告。每次 Agent/RAG 真实任务验收可以明确回答：是否通过、失败原因是什么、是否真的跑了 live LLM、是否真的跑了 PostgreSQL、报告是否已保存、是否保持 readonly。

## 验证

本轮新增默认测试覆盖 gate 成功、失败、run service 集成、fail-fast 错误、readonly 有效证据和 live gate 接线。真实 live 仍由显式环境变量启用，不进入默认测试。

本轮已执行真实组合门控：

- SiliconFlow `deepseek-ai/DeepSeek-V4-Pro`
- 本机 PostgreSQL 测试库 `dbagent_core_tools_test`
- 业务表 fixture
- RAG schema 检索
- Agent 调用 `search_schema` 和 `query_database`
- `gate.json` 输出 `passed=true`
