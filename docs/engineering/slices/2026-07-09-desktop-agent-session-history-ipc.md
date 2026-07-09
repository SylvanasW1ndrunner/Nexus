# 2026-07-09 desktop Agent 会话历史 IPC

## 范围

本切片完成 desktop 后端 Agent 会话历史接线，不开发正式前端 UI。

改动包括：

- shared typed IPC 新增 Agent session 管理合同。
- desktop 主进程创建 `AgentSessionStore` 并注入 `ReactAgent`。
- `HeadlessAgentService` 暴露会话列表、读取、更新、归档、删除、分叉和导出。
- 服务测试覆盖运行后落盘、读取历史、导出 Markdown、归档、分叉和删除。

## 行为说明

Agent 会话保存的是实际执行上下文。通过 Skill 运行时，用户消息会包含 Skill 渲染后的说明、步骤和原始用户任务，便于后续审计和复盘。

## 验收结果

- `vitest run apps/desktop/src/main/agent-service.test.ts packages/core-agent/test/session-store.test.ts --passWithNoTests`：22 passed。
- `tsc -p packages/shared/tsconfig.json --noEmit` 通过。
- `tsc -p apps/desktop/tsconfig.json --noEmit` 通过。
- 相关文件 ESLint 通过。

## 后续

- 给 `AgentSessionStore` 增加按 id 读取元信息的 store-level API，避免详情读取时扫描列表。
- 后续 UI 可基于这些 IPC 实现 Agent 历史面板、导出按钮和分叉入口。
- 实时流式 Agent 输出应作为独立模块实现。
