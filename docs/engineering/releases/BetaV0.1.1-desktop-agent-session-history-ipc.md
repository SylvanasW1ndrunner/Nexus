# BetaV0.1.1 desktop Agent 会话历史 IPC

## 本次能力

- desktop 主进程新增 `data/agent-sessions.json` 会话历史存储。
- `ReactAgent` 在 desktop 运行时自动保存会话。
- 新增 typed IPC：
  - `agent:sessions`
  - `agent:session`
  - `agent:update-session`
  - `agent:archive-session`
  - `agent:delete-session`
  - `agent:fork-session`
  - `agent:export-session`
- 支持会话搜索、读取、更新、归档、删除、分叉和 JSON/Markdown 导出。

## 验证

- `tsc -p packages/shared/tsconfig.json --noEmit`
- `tsc -p apps/desktop/tsconfig.json --noEmit`
- `vitest run apps/desktop/src/main/agent-service.test.ts packages/core-agent/test/session-store.test.ts --passWithNoTests`
- `eslint apps/desktop/src/main/agent-service.ts apps/desktop/src/main/agent-service.test.ts apps/desktop/src/main/main.ts packages/shared/src/ipc.ts`

## 限制

- 当前不开发正式前端 UI。
- 当前使用 JSON store；大量历史和复杂检索后续应迁移 SQLite WAL。
