# BetaV0.1.1 工作区 Agent Eval Suite Loader

## 范围

本切片为 Agent/RAG 验收体系增加工作区自定义 suite 加载能力。用户或团队后续可以在项目内声明 `.dbagent/evals/*.json`，由后端读取、校验并转成统一的 `AgentEvalSuite`，再交给服务层或发布门禁决定是否运行。

当前仍遵守功能优先路线：不开发正式前端 UI，不修改 Electron renderer 宿主。

## 主要变更

- 新增 `loadWorkspaceAgentEvalSuiteManifests(options)`。
- 默认扫描工作区 `.dbagent/evals/*.json`。
- 返回来源相对路径、原始 manifest 和解析后的 suite。
- 复用 `resolveWorkspacePath()`，拒绝从工作区逃逸的路径。
- 单个 manifest 默认限制为 256KB，可由调用方配置。
- 拒绝重复 `suiteId`，错误信息包含冲突文件路径。
- 通过 `packages/core-tools/src/index.ts` 导出能力。

## 安全边界

- loader 只读取工作区文件。
- loader 不运行 Agent、不调用 LLM、不连接数据库、不写报告文件。
- manifest 合同不承载 API key、数据库密码或连接串。
- 真实 LLM、真实 PostgreSQL 和报告写入仍必须由上层服务或测试脚本显式启用。

## 验证

- `vitest run packages/core-tools/test/agent-eval-suite-workspace-loader.test.ts packages/core-tools/test/agent-eval-suite-manifest.test.ts`
- `pnpm --filter @dbagent/core-tools typecheck`

## 下一步

- 增加统一 eval suite catalog：合并官方插件 suite 与工作区 suite。
- 为 suite 增加来源、启用状态、权限提示和运行门禁元数据。
- 后续再由主进程服务提供 typed IPC，前端重建阶段只消费稳定合同。
