# BetaV0.1.1 Agent Eval Suite Catalog

## 范围

本切片为 Agent/RAG 验收体系增加统一 suite catalog。它把官方插件声明的 eval suite 和工作区 `.dbagent/evals/*.json` suite 合并为一个后端合同，供后续服务层、发布门禁和插件市场使用。

本切片仍不涉及正式前端 UI。

## 主要变更

- 新增 `loadAgentEvalSuiteCatalog(options)`。
- 支持 `official` 与 `workspace` 两类来源。
- 官方 `official.agent-rag-eval` 仍默认关闭，必须显式启用。
- 工作区 suite 只有在调用方传入 `workspace` 配置时才读取。
- catalog entry 保留 source metadata，便于后续权限提示和来源展示。
- 合并后拒绝重复 `suiteId`。
- 返回 clone，避免调用方污染 registry 或 workspace 解析结果。

## 安全边界

- catalog 只发现、解析、合并 suite。
- catalog 不运行 Agent、不调用 LLM、不连接数据库、不写报告。
- 真实运行必须由后续服务层或测试脚本显式提供 provider、model、数据库 fixture 和报告目录。

## 验证

- `vitest run packages/core-tools/test/agent-eval-suite-catalog.test.ts packages/core-tools/test/agent-eval-suite-workspace-loader.test.ts packages/core-tools/test/official-plugin-registry.test.ts`
- `pnpm --filter @dbagent/core-tools typecheck`

## 下一步

- 增加 catalog 查询服务和 typed IPC 合同。
- 将 catalog 接入 Agent/RAG live test 与发布质量门禁。
- 增加 suite 启用状态、来源标签、权限提示和运行前确认策略。
