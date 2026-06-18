# BetaV0.1.1 - Agent 行为评估器

## 新增能力

本次在 `packages/core-agent` 增加 `evaluateAgentBehavior()`，用于从用户任务角度评估一次 Agent run 是否符合预期。

评估项支持：

- 期望运行状态，例如 `done`、`permission_denied`、`quota_exceeded`。
- 必须调用的工具。
- 禁止调用的工具。
- 指定工具必须出现的执行状态，例如 `success`、`denied`、`failed`。
- 最终回答必须包含的关键内容。
- 最小/最大迭代次数。

## 开源评估

当前切片不引入 OpenAI Evals、RAGAS、LangSmith、LlamaIndex eval 或其他 Agent eval 依赖。原因：

- 当前目标是建立默认测试可运行的确定性结构化评估基线，不依赖真实 LLM 和外部服务。
- 第三方 eval 通常需要云端服务、LLM judge 或较重依赖，会影响默认测试、离线使用和打包边界。
- Agent run 本身已有结构化状态、工具执行记录和 final text，先直接评估这些用户可感知结果更稳定。

后续接入真实 SiliconFlow/DeepSeek 效果测试、LLM judge 或开源 eval 框架时，必须按 `dbagent-dependency-packaging-review` 做依赖、许可证、成本、离线和安全评估。

## 影响范围

- 新增 `packages/core-agent/src/behavior-evaluation.ts`。
- 扩展 `packages/core-agent/src/types.ts` 和 `packages/core-agent/src/index.ts` 导出。
- 新增 `packages/core-agent/test/behavior-evaluation.test.ts`。
- 更新 `docs/engineering/modules/core-agent.md`。

## 验证

```powershell
C:\Users\cdnzx\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe node_modules\typescript\bin\tsc -p packages\core-agent\tsconfig.json --noEmit
C:\Users\cdnzx\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe node_modules\vitest\vitest.mjs run packages\core-agent\test
```

## 已知限制

- 当前评估器不调用真实 LLM，不判断自然语言答案是否充分，只评估结构化行为结果。
- 真实 provider 行为测试仍通过显式环境变量门控，默认测试不需要 API key。
