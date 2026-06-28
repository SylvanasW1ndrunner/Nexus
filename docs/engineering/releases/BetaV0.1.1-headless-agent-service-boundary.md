# BetaV0.1.1 Headless Agent Service 边界

## 范围

本版本新增无 UI Agent/Skill 主进程服务边界和 typed IPC 合同，为后续统一前端重建提供稳定后端入口。

## 主要变更

- 新增 `skills:match` IPC，用于 Skill 自动匹配诊断。
- 新增 `agent:tool-policy-preview` IPC，用于官方插件工具策略预检。
- 新增 `agent:run` IPC，用于无头自动 Skill Agent 运行。
- 新增 `agent:abort` IPC，用于按 runId 中止运行。
- 新增 `HeadlessAgentService`，组合 `ReactAgent`、`ToolRegistry`、Skill loader、官方插件工具策略和 Auto Skill Agent Runner。
- Desktop main 增加 `core-agent`、`core-skills`、`core-tools` workspace 依赖。

## 验证

- `tsc -p packages/shared/tsconfig.json --noEmit`
- `tsc -p apps/desktop/tsconfig.json --noEmit`
- `eslint apps/desktop/src/main/agent-service.ts apps/desktop/src/main/agent-service.test.ts apps/desktop/src/main/main.ts packages/shared/src/ipc.ts packages/shared/test/ipc-contract.test.ts`
- `vitest run packages/shared/test/ipc-contract.test.ts apps/desktop/src/main/agent-service.test.ts --passWithNoTests`

## 已知边界

- 当前 main service 注册的是空 `ToolRegistry` 和空 `SkillRegistry`，因此真实用户路径还需要下一切片装配 DB/RAG/workspace/Python 工具和内置 Skill 文件。
- 本切片没有真实 LLM、真实 PostgreSQL 或真实 Python 子进程测试。
- renderer UI 仍冻结，没有新增界面入口。
