# BetaV0.1.1 Agent/RAG Eval Suite Manifest

## 范围

本版本为 Agent/RAG 验收 runner 增加 suite manifest 解析能力：

- 支持 `version: 1` manifest。
- 支持 suite metadata、case 验收规则、工具期望和安全 run override。
- 输出可直接传给 `runAgentBehaviorEvaluationSuite()` 的 `AgentEvalSuite`。
- 为后续官方插件和工作区自定义 eval suite 打基础。

## 安全边界

- manifest 不允许覆盖 `providerId`、`model`、`userMessage` 或 `signal`。
- manifest 不承载 API key、数据库密码或连接串。
- parser 不读写文件、不依赖 Electron、不引入新依赖。

## 验证

本轮已执行并通过：

- `vitest run packages/core-tools/test/agent-eval-suite-manifest.test.ts packages/core-tools/test/agent-eval-suite-runner.test.ts`
- `pnpm --filter @dbagent/core-tools typecheck`

## 已知限制

- 当前只提供 parser；工作区文件扫描和官方插件 suite 注册仍待服务层接入。
- 当前 manifest 不支持 LLM judge 或并发策略配置。
