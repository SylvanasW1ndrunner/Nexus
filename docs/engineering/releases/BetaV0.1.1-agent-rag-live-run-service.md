# BetaV0.1.1 Agent/RAG Live Gate Run Service

## 范围

本次切片把 SiliconFlow live Agent/RAG 验收入口迁移到 `AgentEvalSuiteRunService`。

新增能力：

- live gate 通过统一 run service 选择并执行 suite。
- runner/service 支持 `reportRun` 覆盖报告运行元数据。
- live 报告显式写入 `run.live=true`。

## 兼容性

- `scripts/run-agent-rag-live-tests.mjs` 命令入口不变。
- `DBAGENT_AGENT_RAG_SUITE_ID` 和 `DBAGENT_AGENT_RAG_EVAL_WORKSPACE` 仍可选择 suite。
- 报告目录和文件名保持兼容。
- 未修改前端 UI、Electron IPC 或 preload。
- 未新增 npm 依赖。

## 验收重点

- 默认测试不消耗真实 LLM。
- 显式 live gate 仍调用真实 SiliconFlow `deepseek-ai/DeepSeek-V4-Pro`。
- 报告同时包含 suite source 和 `run.live=true`。
- run service 的真实依赖门禁仍保留。

## 已知限制

- 当前 PostgreSQL gate 仍有部分路径直接调用 runner，后续可继续迁移到 run service。
- `reportRun` 是报告元数据覆盖，不改变 Agent 实际执行配置。
