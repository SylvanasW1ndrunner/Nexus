# BetaV0.1.1 官方 Eval Suite Resolution

## 范围

本版本为官方 eval 插件增加 suite resolution 入口：

- `OfficialPluginRegistry.resolveEvalSuites(options)`。
- 默认只解析已启用插件里的 suite。
- 支持 `suiteIds` 过滤。
- 返回可运行的 `AgentEvalSuite` 和 raw manifest clone。
- 拒绝重复 suite id。

## 安全边界

- `resolveEvalSuites()` 不运行 Agent、不调用 LLM、不连接数据库、不写报告。
- `official.agent-rag-eval` 默认关闭，调用方必须显式启用。
- 真实执行仍由测试脚本、服务层或后续设置页显式触发。

## 验证

本轮已执行并通过：

- `vitest run packages/core-tools/test/official-plugin-registry.test.ts packages/core-tools/test/agent-eval-suite-manifest.test.ts`
- `pnpm --filter @dbagent/core-tools typecheck`

## 已知限制

- 当前只负责官方插件 suite resolution；工作区 eval manifest 文件扫描仍未接入。
- 当前还没有“一键执行官方 suite”的服务层封装。
