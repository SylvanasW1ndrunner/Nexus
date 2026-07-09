# BetaV0.1.1 desktop Agent 流式响应历史 IPC

## 本次能力

- desktop 主进程新增 `data/agent-streams.json`。
- `ReactAgent` 在 desktop 运行时启用 stream store。
- 新增 typed IPC：
  - `agent:streams`
  - `agent:stream`
  - `agent:recoverable-streams`
- 支持查询按 session 归属的流式响应记录，以及异常退出后仍处于 streaming/incomplete 的可恢复 stream。

## 验证

- `tsc -p packages/shared/tsconfig.json --noEmit`
- `tsc -p apps/desktop/tsconfig.json --noEmit`
- `vitest run apps/desktop/src/main/agent-service.test.ts packages/core-agent/test/stream-store.test.ts packages/core-agent/test/react-agent.test.ts --passWithNoTests`
- `eslint apps/desktop/src/main/agent-service.ts apps/desktop/src/main/agent-service.test.ts apps/desktop/src/main/main.ts packages/shared/src/ipc.ts`

## 限制

- 本版本只提供后端持久化和读取，不开发正式前端 UI。
- 实时事件推送仍需后续基于 `agent:event` 单独实现。
