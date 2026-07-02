# BetaV0.1.1 官方 Agent/RAG Eval Suite

## 范围

本版本让官方插件机制开始承载 Agent/RAG eval suite：

- `OfficialPluginManifest` 支持可选 `evalSuites`。
- `official.agent-rag-eval` 声明默认 `official.agent-rag.business-readonly` suite。
- registry 注册时校验 eval suite manifest。
- registry 返回 clone，防止调用方污染默认 suite。

## 安全边界

- eval 插件仍默认关闭。
- eval 插件不贡献 Agent tool。
- 默认 suite 不包含 provider、model、API key、数据库密码或连接串。
- 非 eval 插件不能声明 eval suite。

## 验证

本轮已执行并通过：

- `vitest run packages/core-tools/test/official-plugin-registry.test.ts packages/core-tools/test/agent-eval-suite-manifest.test.ts`
- `pnpm --filter @dbagent/core-tools typecheck`

## 已知限制

- 当前还没有服务层按插件 id 执行 suite。
- 工作区自定义 suite 文件扫描仍未接入。
