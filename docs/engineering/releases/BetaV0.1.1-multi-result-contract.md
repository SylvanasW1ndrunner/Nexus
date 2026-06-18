# BetaV0.1.1 - 多语句结果集合同

## 背景

产品文档要求 SQL 编辑器运行多语句文件时，结果区出现“结果1/结果2/...”，消息区展示每条语句的执行信息。此前 PostgreSQL driver 会把 `pg` 返回的多结果数组归一为最后一个结果，用户运行整文件时会丢失前面语句的结果。

## 变更

- `QueryExecutionResult` 新增可选字段：
  - `resultSets`：每条语句的结果集，包含 index、command、columns、rows 和 rowCount。
  - `messages`：面向消息区的执行摘要。
- `PostgresDriver.execute()` 保留多语句返回数组，不再只取最后一个结果。
- 为兼容现有调用方，顶层 `columns`、`rows`、`rowCount` 仍保留：
  - 优先指向第一个有列的结果集。
  - 如果没有查询结果集，则指向最后一个 DML/DDL 结果。

## 开源评估

本切片不新增依赖。多语句结果集是 DBAgent 自身 driver/IPC 合同，需要根据产品结果区和消息区语义定义；直接复用 `pg` 返回结构并归一化即可。

## 验证

- 扩展 `packages/core-db/test/postgres-driver-runtime-errors.test.ts`。
- 覆盖 SELECT + UPDATE + SELECT 的多语句执行，验证顶层兼容结果、完整 `resultSets` 和用户可见 `messages`。
