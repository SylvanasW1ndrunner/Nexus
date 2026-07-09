# desktop Agent 会话历史 IPC

## 目标

本模块把 `core-agent` 已有的 `AgentSessionStore` 接入 desktop 主进程，提供后续 Agent 历史面板、对话恢复、导出、分叉和问题复盘需要的 typed IPC 能力。当前阶段不开发 renderer UI。

## 存储位置

- 文件：`data/agent-sessions.json`
- 创建方：`apps/desktop/src/main/main.ts`
- 写入方：
  - `ReactAgent` 在每次运行过程中通过 `sessionStore` 自动保存用户消息、assistant 消息、tool result 和 token usage。
  - `HeadlessAgentService` 通过 IPC 操作更新、归档、分叉或删除会话。

## IPC 合同

- `agent:sessions`
  - 请求：`AgentSessionsRequest`
  - 响应：`AgentSessionsResponse`
  - 用途：分页列出 active 或 archived 会话，支持按标题/消息内容搜索。
- `agent:session`
  - 请求：`AgentSessionRequest`
  - 响应：`AgentSessionDetail`
  - 用途：读取完整会话消息。
- `agent:update-session`
  - 请求：`AgentUpdateSessionRequest`
  - 响应：`AgentSessionSummary`
  - 用途：修改标题、模式或 aborted 状态。
- `agent:archive-session`
  - 请求：`AgentArchiveSessionRequest`
  - 响应：`AgentSessionSummary`
  - 用途：归档或恢复会话。
- `agent:delete-session`
  - 请求：`AgentSessionRequest`
  - 响应：`AgentDeleteSessionResponse`
  - 用途：删除会话。
- `agent:fork-session`
  - 请求：`AgentForkSessionRequest`
  - 响应：`AgentSessionDetail`
  - 用途：从指定消息位置创建分支会话。
- `agent:export-session`
  - 请求：`AgentExportSessionRequest`
  - 响应：`AgentExportSessionResponse`
  - 用途：导出 JSON 或 Markdown。

## 服务边界

- `packages/shared/src/ipc.ts` 只定义可序列化合同，不直接引用 `core-agent` 类型。
- `apps/desktop/src/main/agent-service.ts` 负责把 core session summary/detail 转成 shared 类型。
- `AgentSessionStore` 继续负责原子 JSON 写入、损坏 JSON 降级、脱敏、归档、分叉和导出。
- `ReactAgent` 的运行路径不需要 UI 参与即可保存会话历史。

## 安全策略

- 会话保存、读取、导出复用 `core-agent` 的 redaction 规则，避免 API key、Bearer token、数据库 URL 密码和 password 字段明文落盘。
- IPC 返回的是已脱敏数据。
- 删除会话只删除本地历史，不影响 query history、audit log 或 plan recovery 快照。

## 测试覆盖

- desktop 服务级测试验证一次真实 `HeadlessAgentService.run()` 会写入 session store。
- 列表、读取、Markdown 导出会返回实际执行上下文。
- 更新标题、归档、恢复、分叉和删除走同一个持久化 store。
- core `AgentSessionStore` 既有测试继续覆盖损坏 JSON、脱敏、fork/export 和 ReactAgent 集成。

## 开源与依赖评估

本切片不新增依赖。会话历史当前使用本地 JSON 原子写入，符合 beta 阶段轻量、可打包、Windows/Linux 兼容的要求。SQLite WAL 或外部事件存储更适合大量会话和复杂检索，但会增加迁移与打包复杂度；后续如果会话规模扩大，应在不改变 IPC 合同的前提下替换 store 实现。

## 已知限制

- 详情读取会通过 active/archived summary 列表补齐归档状态；会话量很大时应在 store 层补 `loadRecord()` 或迁移 SQLite。
- 当前没有增量流式事件 IPC；本模块提供历史读取和管理能力，实时流式输出仍由后续 `agent:event` 模块处理。
