# Agent/RAG 评估发布门禁切片

## 背景

Agent/RAG 已有 suite catalog、suite runner、run service、真实 PostgreSQL gate 和 SiliconFlow live gate。但此前发布判断主要依赖 Vitest 断言和人工阅读报告，缺少可复用、可机器消费的 gate 决策。

## 本轮实现

- 新增 `AgentEvalGatePolicy` 和 `evaluateAgentEvalGate()`。
- `AgentEvalSuiteRunService.run()` 支持可选 `gate` 和 `failOnGateFailure`。
- 新增 `AgentEvalSuiteGateError`，门禁失败时携带完整 gate 决策。
- live Agent/RAG 测试接入 gate。
- 设置 `DBAGENT_AGENT_RAG_REPORT_DIR` 时输出 `gate.json`。
- 修复真实 live+PostgreSQL 组合门控暴露的问题：readonly 证据必须基于合成后的实际运行模式，而不是只看 manifest 是否显式声明 `run.mode`。

## 验收标准

- 默认调用不传 gate 时保持兼容。
- 传入 gate 后返回 `passed/failures/warnings/metrics`。
- strict gate 能要求 live、PostgreSQL、report saved、readonly、工具白名单和禁用工具。
- 门禁失败时可以选择只返回结果，也可以 fail-fast 抛错。
- `baseRun.mode='readonly'` 且 suite 没有覆盖成非只读模式时，readonly gate 通过。
- 默认测试不依赖网络、不消耗 LLM key。

## 后续

- 扩展官方 suite 到 3-5 个 live case，覆盖同义表达、隐私请求、SQL 修复和数值正确性。
- 在 release 脚本中读取 `gate.json`，把 gate 失败作为 release artifact 阻断条件。
- 为真实 PostgreSQL gate 增加只读数据库用户验证。
