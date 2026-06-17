# BetaV0.1.1 查询结果快照存储

## 范围

本次新增 `core-db` 的查询结果快照后端能力，用于支撑传统数据库 IDE 中“钉住查询结果，重启后保留”的工作流。该能力不包含前端 UI，只提供可由主进程、IPC 或测试调用的服务契约。

## 功能

- 新增 `QuerySnapshotStore`。
- 支持创建、列表、读取、删除查询快照。
- 快照保存连接 ID、queryId、SQL、列、行、rowCount、elapsedMs、安全报告、标签、备注和来源历史 ID。
- 列表返回 `previewRows`，完整行数据通过 `get(id)` 读取。
- 支持按连接过滤和按标题、SQL、备注、标签搜索。
- 默认最多保留 200 条快照，避免本地文件无限增长。

## 数据安全

- 快照只写入本地文件，不上传。
- 快照不保存数据库密码、API key 或连接密钥。
- 数据库特殊值会转换成稳定 JSON：
  - `bigint` 保存为 `{ type: "bigint", value }`
  - `Date` 保存为 ISO 时间
  - `Buffer` 保存为 base64
  - JSONB/数组递归保存
- 快照文件损坏时按空列表处理，应用继续可用。

## 测试

- `packages/core-db/test/query-snapshot.test.ts`
  - 钉住查询结果。
  - 保存 `bigint`、`Date`、`Buffer`、JSONB。
  - 列表按时间倒序、连接过滤、搜索和预览行。
  - 删除快照。
  - 损坏 JSON 降级。
  - 快照数量上限。

## 限制

- 当前使用 JSON 文件存储，适合 Beta 阶段和中小规模本地快照。
- 大规模快照、全文检索和审计级留存后续应迁移到 SQLite。
