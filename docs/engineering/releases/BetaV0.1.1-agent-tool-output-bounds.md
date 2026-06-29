# BetaV0.1.1 Agent 工具结果限幅

## 变更

- Agent 工具结果写入 session/checkpoint 前会统一限幅。
- 超长工具结果返回结构化摘要，包含 `tool_result_too_large` 标记。
- 工具超时错误现在包含真实超时毫秒数。
- `react-agent.test.ts` 新增大结果场景测试。

## 验证

- `vitest run packages/core-agent/test/react-agent.test.ts --passWithNoTests`
- `tsc -p packages/core-agent/tsconfig.json --noEmit`
- `eslint packages/core-agent/src/react-agent.ts packages/core-agent/test/react-agent.test.ts`

## 依赖与打包

本次没有新增依赖，不影响 Electron 打包和离线安装。

## 已知边界

- 当前只保留摘要，不保存完整原始结果。
- 后续需要引入 artifact/archive store，让用户能查看完整 SQL/Python/MCP 输出。
