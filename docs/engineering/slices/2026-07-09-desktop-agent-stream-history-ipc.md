# 2026-07-09 desktop Agent 流式响应历史 IPC

## 范围

本切片完成 desktop 后端 Agent stream 持久化接线，不开发正式前端 UI。

改动包括：

- shared typed IPC 新增 `agent:streams`、`agent:stream`、`agent:recoverable-streams`。
- desktop 主进程创建 `AgentStreamStore` 并注入 `ReactAgent`。
- `HeadlessAgentService` 暴露 stream 列表、详情和可恢复 stream 查询。
- 服务测试覆盖真实 provider stream 落盘和 recoverable stream 查询。

## 行为说明

配置 `AgentStreamStore` 后，`ReactAgent` 会走 `LlmRouter.stream()`。如果 provider 没有原生 stream，router 会把普通 chat response 转成 stream 事件；如果 provider 有原生 stream，则逐事件持久化。

## 验收结果

- `vitest run apps/desktop/src/main/agent-service.test.ts packages/core-agent/test/stream-store.test.ts packages/core-agent/test/react-agent.test.ts --passWithNoTests`：49 passed。
- `tsc -p packages/shared/tsconfig.json --noEmit` 通过。
- `tsc -p apps/desktop/tsconfig.json --noEmit` 通过。
- 相关文件 ESLint 通过。

## 后续

- 基于同一合同实现实时 `agent:event` 推送。
- 为 stream store 增加按 session/时间范围分页，避免大文件扫描。
- 把 incomplete stream 与 Agent 恢复提示合并到启动恢复扫描中。
