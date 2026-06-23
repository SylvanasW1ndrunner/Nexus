# BetaV0.1.1 - SiliconFlow 真实 LLM 门控测试入口

## 背景

当前阶段需要验证 OpenAI-compatible provider 能真实连接 SiliconFlow，并使用 `deepseek-ai/DeepSeek-V4-Pro` 模型完成普通 chat 和 streaming。默认测试不能依赖网络和密钥，因此真实调用必须显式门控。

## 变更内容

- `openai-compatible-provider.test.ts` 的 live integration 支持：
  - `DBAGENT_RUN_LLM_INTEGRATION=1`
  - `TEST_SILICONFLOW_API_KEY`
  - `TEST_SILICONFLOW_MODEL`，默认 `deepseek-ai/DeepSeek-V4-Pro`
- 保留旧的 `DBAGENT_LLM_API_KEY` 兼容入口。
- 更新 `core-llm` 中文模块文档，说明本机临时环境变量运行方式。

## 安全边界

- 不把真实 API key 写入代码、文档、配置、测试快照或提交记录。
- 默认测试继续使用 fake fetch，不要求网络。
- live integration 只在显式设置 `DBAGENT_RUN_LLM_INTEGRATION=1` 且提供本机环境变量时运行。

## 验证

默认校验：

```powershell
node .\node_modules\vitest\vitest.mjs run packages\core-llm\test
```

真实 SiliconFlow 校验：

```powershell
$env:DBAGENT_RUN_LLM_INTEGRATION='1'
$env:TEST_SILICONFLOW_API_KEY='<本机临时密钥>'
$env:TEST_SILICONFLOW_MODEL='deepseek-ai/DeepSeek-V4-Pro'
node .\node_modules\vitest\vitest.mjs run packages\core-llm\test\openai-compatible-provider.test.ts
```
