# BetaV0.1.1 Agent Eval Suite Run Service

## 范围

本次版本切片新增 Agent/RAG 评测套件运行服务，继续保持“功能优先、前端冻结”的开发路线。

新增能力：

- `AgentEvalSuiteRunService.run()`：按 `suiteId` 从 catalog 选择 suite 并执行。
- 自动把 official/workspace suite 来源写入报告。
- 默认阻止真实 PostgreSQL 和真实 LLM suite 的隐式执行。
- 支持将 `reportStorePath`、`generatedAt`、`reportId`、`stopOnFirstFailure` 透传给 runner。

## 安全边界

- `postgres` suite 必须显式传入 `allowPostgresSuites: true`。
- `llm-live` suite 必须显式传入 `allowLiveSuites: true`。
- 未授权时在调用 Agent 前失败。
- service 不读取 API key、数据库密码或连接串。

## 兼容性

- 未修改 renderer UI。
- 未修改 Electron 主进程、preload 或 IPC 合同。
- 未新增 npm 依赖。
- 未改变 runner 的行为评估语义。

## 验收重点

- 工作区 suite 能通过 catalog service 选择并执行。
- 报告包含 suite source，方便追踪验收来源。
- 真实依赖 suite 不会被默认误执行。
- suite 不存在时返回明确错误。

## 已知限制

- 当前 service 尚未接入主进程 IPC。
- 当前 live test 脚本仍直接组合 catalog 和 runner，后续可迁移到 run service。
- 当前不内置第三方 eval 平台 adapter。
