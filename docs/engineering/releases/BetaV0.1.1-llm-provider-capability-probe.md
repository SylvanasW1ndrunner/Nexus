# BetaV0.1.1 - LLM Provider 能力探针

## 新增能力

本次在 `packages/core-llm` 增加 `probeLlmProviderCapabilities()`，用于无 UI 验证 provider/model 是否能支撑 DBAgent 后续 Agent 能力。

探针覆盖：

- provider 端点可用性。
- 普通 chat 非空响应。
- tool calling：要求模型调用 `dbagent_probe_echo`。
- streaming：检查 `text-delta` 和 `finish` 事件。

## 用户价值

用户配置 SiliconFlow、OpenAI-compatible、Ollama/vLLM 或未来订阅网关后，可以先通过后端探针得到结构化诊断，而不是等 Agent 运行失败后才发现模型不支持工具调用、流式输出不可用或 endpoint 配错。

## 开源评估

当前切片不引入 OpenAI Evals、LangSmith、LlamaIndex 或其他外部 eval 依赖。原因：

- 目标是 provider 配置健康检查和基础能力探测，不是完整模型质量评测。
- 当前逻辑可以用现有 provider 合同直接实现，依赖更少、默认测试更稳定。
- 第三方评估框架通常需要云服务、数据集或 LLM judge，不适合作为基础设置诊断的默认依赖。

后续如果建设完整 LLM/Agent eval pipeline，再按 `dbagent-dependency-packaging-review` 评估优秀开源组件。

## 影响范围

- 新增 `packages/core-llm/src/provider-capability-probe.ts`。
- 更新 `packages/core-llm/src/index.ts` 导出。
- 新增 `packages/core-llm/test/provider-capability-probe.test.ts`。
- 更新 `docs/engineering/modules/core-llm.md`。

## 验证

```powershell
C:\Users\cdnzx\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe node_modules\typescript\bin\tsc -p packages\core-llm\tsconfig.json --noEmit
C:\Users\cdnzx\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe node_modules\vitest\vitest.mjs run packages\core-llm\test
```

## 已知限制

- 探针只能证明当前模型/端点在探针提示下可用，不等价于完整业务 Agent 评测。
- 真实 SiliconFlow/DeepSeek 调用仍通过 `DBAGENT_RUN_LLM_INTEGRATION=1` 和 `DBAGENT_LLM_API_KEY` 环境变量门控。
