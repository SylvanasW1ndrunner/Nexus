# 2026-07-02 Agent Eval Suite Catalog

## 背景

官方 eval suite resolution 和工作区 `.dbagent/evals/*.json` loader 已经具备，但调用方仍需要分别读取两套来源。为了后续主进程服务、发布门禁和插件市场共用同一合同，本切片增加统一 catalog：只做 suite 发现、解析、合并和来源标记，不负责执行。

## 本轮实现

- `packages/core-tools/src/agent-eval-suite-catalog.ts`
  - 新增 `loadAgentEvalSuiteCatalog(options)`。
  - 支持官方插件来源和工作区来源。
  - 返回 `AgentEvalSuiteCatalogEntry[]`，每个 entry 包含 `suiteId`、`suiteName`、`environment`、`source`、raw `manifest` 和 parsed `suite`。
  - 合并后拒绝重复 `suiteId`，错误信息包含冲突来源。
  - 返回 clone，避免调用方修改污染后续加载。
- `packages/core-tools/src/index.ts`
  - 导出 catalog 合同。
- `packages/core-tools/test/agent-eval-suite-catalog.test.ts`
  - 使用真实临时工作区和真实文件 IO 测试工作区来源。
  - 覆盖显式启用官方 suite、默认禁用官方 eval、仅加载工作区、跨来源重复 suite id、clone 防污染。

## 安全边界

- catalog 不运行 Agent。
- catalog 不调用 LLM。
- catalog 不连接 PostgreSQL。
- catalog 不写报告文件。
- provider、model、数据库 fixture、报告目录、真实依赖开关和权限提示继续由后续服务层控制。

## 验收

- `vitest run packages/core-tools/test/agent-eval-suite-catalog.test.ts packages/core-tools/test/agent-eval-suite-workspace-loader.test.ts packages/core-tools/test/official-plugin-registry.test.ts` 通过。
- `pnpm --filter @dbagent/core-tools typecheck` 通过。

## 后续

- 在主进程或 core-tools 服务层增加 suite catalog 查询服务。
- 增加 catalog 级启用/禁用配置、来源标签和权限提示。
- 将 catalog 接入 `test:agent-rag-live` 或发布门禁脚本，避免脚本硬编码 suite 来源。
