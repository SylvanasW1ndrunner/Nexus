# BetaV0.1.1 Agent/RAG PostgreSQL Gate Run Service

## 范围

本次切片把真实 PostgreSQL Agent/RAG 验收迁移到 `AgentEvalSuiteRunService`。

新增能力：

- PostgreSQL gate 从临时工作区 `.dbagent/evals/postgres-business.json` 加载 suite。
- 通过 run service 执行真实 PostgreSQL Agent/RAG 验收。
- 报告保留 workspace suite source，并继续标记 `run.postgres=true`。

## 兼容性

- `pnpm test:postgres` 入口不变。
- PostgreSQL 环境变量不变。
- 未修改前端 UI、Electron IPC 或 preload。
- 未新增 npm 依赖。

## 验收重点

- 默认测试不触发真实 PostgreSQL。
- 显式 PostgreSQL gate 继续创建真实业务表、抽取 catalog、索引 RAG 并执行 Agent 工具链。
- PostgreSQL suite 必须显式打开 `allowPostgresSuites` 才能执行。
- 报告记录 workspace suite source。

## 已知限制

- 当前 PostgreSQL gate 仍使用 scripted provider，不消耗真实 LLM；真实 LLM 覆盖由 SiliconFlow live gate 提供。
- 当前 suite manifest 在测试运行时写入临时工作区，后续 release CLI 可改为读取项目内固定验收 suite。
