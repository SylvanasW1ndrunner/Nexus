# BetaV0.1.1 Agent/RAG Eval Suite Runner

## 范围

本版本新增 Agent/RAG 业务验收套件 runner，为后续官方评估插件和 release gate 做后端准备。

新增内容：

- `runAgentBehaviorEvaluationSuite()`：批量运行 Agent 用例、执行行为评估、生成脱敏报告。
- `official.agent-rag-eval`：默认关闭的官方插件 manifest，不向 Agent 默认暴露工具。
- 测试覆盖成功报告、失败提前停止、空套件错误、官方 manifest registry。

## 验证

已执行窄范围验证：

- `vitest run packages/core-tools/test/agent-eval-suite-runner.test.ts packages/core-tools/test/official-plugin-registry.test.ts`

完整质量门禁将在提交前执行。

## 已知限制

- 当前 suite runner 串行执行。
- suite 定义暂由调用方传入，后续由官方插件或工作区文件提供。
- 当前不包含 LLM judge。
