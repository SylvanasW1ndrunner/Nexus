# 2026-07-02 官方 Eval Suite Resolution

## 背景

`official.agent-rag-eval` 已能声明默认 suite manifest，但调用方还缺少一个稳定入口把已启用官方插件里的 suite 解析成可运行的 `AgentEvalSuite`。如果后续服务层直接读取 manifest 字段，会导致插件启用规则、suite 去重和 clone 防污染逻辑分散。

## 本轮实现

- `packages/core-tools/src/official-plugin-registry.ts`
  - 新增 `OfficialPluginEvalSuiteResolutionOptions`。
  - 新增 `OfficialPluginEvalSuiteResolution`。
  - 新增 `resolveEvalSuites(options)`。
  - 默认只从已启用插件解析 suite。
  - 支持 `suiteIds` 过滤。
  - 解析阶段拒绝重复 suite id。
  - 返回 parsed suites 和 raw manifest clone。
- `packages/core-tools/test/official-plugin-registry.test.ts`
  - 覆盖默认不返回关闭插件 suite。
  - 覆盖显式启用 `official.agent-rag-eval` 后解析 suite。
  - 覆盖 suiteId 过滤、重复 suite id、clone 防污染。

## 安全边界

- 默认关闭的 eval 插件不会被隐式解析或执行。
- `resolveEvalSuites()` 只解析 suite，不运行 Agent、不调用 LLM、不连接数据库、不写报告。
- 真实执行仍必须由调用方显式提供 `baseRun`、fixture/连接和报告目录。

## 验收

- `vitest run packages/core-tools/test/official-plugin-registry.test.ts packages/core-tools/test/agent-eval-suite-manifest.test.ts` 通过。
- `pnpm --filter @dbagent/core-tools typecheck` 通过。

## 后续

- 增加服务层：读取官方 suite resolution，组合调用方 `baseRun` 后执行 `runAgentBehaviorEvaluationSuite()`。
- 增加工作区 eval manifest 文件扫描。
