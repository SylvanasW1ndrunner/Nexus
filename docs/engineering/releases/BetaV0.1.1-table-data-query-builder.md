# BetaV0.1.1 表数据浏览查询构建器

## 范围

本次新增 `core-db` 的表数据浏览 SQL 构建能力，并打通 `QueryRequest.params` 到 PostgreSQL driver。该能力用于支撑产品文档中的表数据浏览：列选择、筛选、排序、分页和大表保护。本次不包含前端 UI。

## 功能

- 新增 `buildTableDataQuery()`。
- 支持可见列选择，空列列表时使用 `select *`。
- 支持多条件 AND 筛选。
- 支持多列排序。
- 默认分页 100 行，最大 1000 行。
- offset 负数或过大时自动 clamp 并返回 warning。
- 支持高级 WHERE 片段，并返回“需要审查”的 warning。
- `QueryRequest` 新增 `params?: unknown[]`。
- `PostgresDriver.execute()` 会将 `params` 传给 `pg`，支持参数化 SQL。

## 安全边界

- schema、table、column、sort column 统一做 PostgreSQL identifier quote。
- 普通筛选值全部使用 `$1`、`$2` 参数占位，不拼进 SQL 文本。
- 高级 WHERE 是用户/Agent 直接提供的 SQL 片段，构建器只去掉开头 `WHERE` 并返回 warning；调用方必须在执行前审查。
- 分页默认限制防止首次打开大表时拖垮数据库或本地进程。

## 测试

- `packages/core-db/test/sql-builder.test.ts`
  - 列选择、筛选、排序、分页。
  - LIKE 输入中的注入文本不进入 SQL。
  - IN、BETWEEN、NULL、高级 WHERE。
  - limit/offset clamp。
- `packages/core-db/test/postgres-driver-runtime-errors.test.ts`
  - 参数化查询值传入 PostgreSQL pool。

## 限制

- 当前构建器面向 PostgreSQL 方言。
- 高级 WHERE 暂不解析 SQL AST，只提供 warning 和执行前审查边界。
- 大 offset 仍可能性能较差，后续应增加 keyset pagination 合同。
