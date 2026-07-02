# 2026-07-02 官方 Agent/RAG Eval Suite

## 背景

Suite manifest parser 已经可用，但 `official.agent-rag-eval` 仍只是一个默认关闭的插件外壳。为了让官方插件机制真正承载后端能力，需要先让官方 eval 插件声明一个可解析、可验证、可 clone 的默认 suite manifest。

## 本轮实现

- `packages/core-tools/src/official-plugin-registry.ts`
  - `OfficialPluginManifest` 新增可选 `evalSuites`。
  - 新增 `DEFAULT_AGENT_RAG_EVAL_SUITE_MANIFEST`。
  - `official.agent-rag-eval` 声明 `official.agent-rag.business-readonly` suite。
  - registry 注册时调用 `parseAgentEvalSuiteManifest()` 校验 suite。
  - registry 拒绝非 eval 插件声明 eval suite。
  - clone manifest 时深拷贝 `evalSuites`，避免调用方污染默认声明。
- `packages/core-tools/test/official-plugin-registry.test.ts`
  - 覆盖默认 eval suite、parser 兼容、错误插件类别、空 suite 和 clone 防突变。

## 安全边界

- 官方 eval 插件仍默认关闭。
- 官方 eval 插件不贡献 Agent tool，不会暴露给模型直接调用。
- 默认 suite 不包含 provider、model、API key、数据库密码或连接串。
- 调用方仍必须显式提供 baseRun、fixture 和报告输出目录。

## 验收

- `vitest run packages/core-tools/test/official-plugin-registry.test.ts packages/core-tools/test/agent-eval-suite-manifest.test.ts` 通过。
- `pnpm --filter @dbagent/core-tools typecheck` 通过。

## 后续

- 提供服务层方法：按插件 id 读取 eval suites，并与调用方 baseRun 组合执行。
- 增加工作区 `.dbagent/evals/*.json` suite manifest 加载。
