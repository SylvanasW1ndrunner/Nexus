# BetaV0.1.1 - 长 SQL 取消合同

## 背景

产品文档要求长 SQL 可以取消：优先调用 PostgreSQL 的 backend cancel 路径，如果取消超时，则断开当前查询所在连接，且不能影响其他连接或其他查询。当前前端 UI 延后，但后端必须先形成可复用合同，供未来 IPC、Agent 工具、查询面板和真实 PostgreSQL driver 接线使用。

## 变更内容

- 新增 `packages/core-db/src/query-cancellation.ts`。
- 新增 `QueryCancellationRegistry`，维护运行中查询、取消请求、完成、失败、已取消和清理状态。
- 新增取消决策：
  - `cancel-backend`：已知 PostgreSQL backend pid 时，优先调用 `pg_cancel_backend(pid)`。
  - `disconnect-connection`：缺少 backend pid 或 cancel 超时后，断开当前查询所在连接。
  - `already-finished`：查询已经完成、失败或取消，不重复操作。
  - `not-found`：查询不存在或已经被清理。
- 导出模块入口，供后续 main process query workflow 和 IPC 使用。

## 开源评估

本切片不新增依赖。查询取消注册表是 DBAgent 的运行状态合同，主要负责把产品规则转换成稳定决策，不适合直接引入通用库。后续真实 PostgreSQL 取消会基于现有 `pg` 连接能力接线，并继续评估是否需要额外抽象；当前不引入 SQL/Agent/RAG 外部依赖，避免增加打包和离线风险。

## 测试覆盖

- 注册运行中查询并按连接筛选。
- 拒绝空 query id、空 connection id、空 SQL 和非法 backend pid。
- 已知 backend pid 时生成 `cancel-backend` 决策。
- cancel 超时前继续建议 backend cancel，并返回剩余等待时间。
- cancel 超时后降级为 `disconnect-connection`。
- 缺少 backend pid 时直接建议断开当前连接。
- 已完成查询不会再次取消。
- 已取消和失败查询保留审计字段。
- 清理过期完成记录时不影响仍在运行的查询。

## 已知限制

- 本切片只实现取消注册表和决策，不直接调用 `pg_cancel_backend`。
- `PostgresDriver.execute()` 还未把 query id 与 backend pid 绑定到 registry。
- IPC `db:cancel-query` 仍待下一切片接入。
