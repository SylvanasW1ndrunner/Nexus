# 2026-07-10：查询历史与结果快照 IPC / Agent 接线

## 背景

产品文档要求传统 IDE 能力提供 SQL 历史和结果快照。core-db 已有基础 store，但缺少完整共享 IPC 合同、主进程快照入口，以及 Agent 可读取 SQL 历史的官方工具。

## 本轮实现

- `@dbagent/shared` 增加 Query Snapshot 公共类型和 4 个 IPC 通道。
- `QuerySnapshotStore` 改为复用 shared 公共类型。
- 主进程新增 `QuerySnapshotStore` 实例和快照 IPC handler。
- `registerDatabaseTools()` 增加可选 `history` 依赖。
- 新增 Agent 工具 `read_query_history`。
- `registerDesktopAgentTools()` 可传入 `queryHistory`，桌面端实际传入 `queryHistoryStore`。
- `official.database-postgres` 增加 `sql-history` capability 和 `read_query_history` 工具声明。

## 验证

- shared/core-db/core-tools TypeScript 检查通过。
- 聚焦 Vitest 通过：
  - `packages/shared/test/ipc-contract.test.ts`
  - `packages/core-db/test/query-snapshot.test.ts`
  - `packages/core-tools/test/db-tools.test.ts`
  - `packages/core-tools/test/official-plugin-registry.test.ts`
  - `apps/desktop/src/main/agent-tool-bootstrap.test.ts`

## 后续

架构师 Agent 和测试 Agent 都建议下一轮转向 `core-rag` 持久化混合检索与真实渐进索引。该模块是 Agent/RAG 生产级能力的更大瓶颈。
