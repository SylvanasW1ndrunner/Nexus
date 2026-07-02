# 2026-07-02 Agent/RAG Eval Suite Manifest

## 背景

默认 fixture、真实 PostgreSQL 和 SiliconFlow live Agent/RAG 验收已经统一到 `runAgentBehaviorEvaluationSuite()`。下一步需要让 suite 定义可以来自官方插件或工作区文件，而不是长期硬编码在测试代码里。

## 本轮实现

- `packages/core-tools/src/agent-eval-suite-manifest.ts`
  - 新增 `parseAgentEvalSuiteManifest(input)`。
  - 新增 `parseAgentEvalSuiteManifestJson(json)`。
  - 支持 `version: 1` manifest，输出可直接传给 runner 的 `AgentEvalSuite`。
  - 支持 suite metadata、case 验收规则、工具期望、最终回答断言和安全 run override。
- `packages/core-tools/src/index.ts`
  - 导出 manifest parser。
- `packages/core-tools/test/agent-eval-suite-manifest.test.ts`
  - 覆盖成功解析、JSON 文本解析、非法 JSON、重复 case、非法状态、非法迭代范围、非法工具调用次数范围和禁止覆盖 provider/model。

## 安全边界

- manifest 不允许覆盖 `providerId`、`model`、`userMessage` 或 `signal`。
- manifest 不承载 API key、数据库密码或连接串。
- parser 不读写文件、不依赖 Electron、不引入新依赖。
- 文件来源、路径边界和权限控制后续由官方插件或工作区服务层负责。

## 开源方案评估

- JSON Schema / Ajv：适合复杂 schema 和第三方生态，但本切片字段有限，引入会增加依赖和打包面。
- Zod：开发体验好，但当前仓库还没有引入，且 parser 只在 core-tools 内部使用，暂不值得增加依赖。
- promptfoo / OpenAI Evals manifest：可借鉴 suite/case 分层，但无法直接表达 DBAgent 工具权限、脱敏报告和 run override 边界。

本轮选择轻量自研 parser，后续如果 manifest 扩展到插件市场配置、权限声明和远程 suite，可再把校验层替换为 schema validator。

## 验收

- `vitest run packages/core-tools/test/agent-eval-suite-manifest.test.ts packages/core-tools/test/agent-eval-suite-runner.test.ts` 通过。
- `pnpm --filter @dbagent/core-tools typecheck` 通过。

## 后续

- 在官方 `official.agent-rag-eval` 插件中声明默认 suite manifest。
- 增加工作区服务层：扫描 `.dbagent/evals/*.json`，做路径边界和来源权限检查后加载 suite。
