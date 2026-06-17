# BetaV0.1.1 表数据编辑预览与事务保护

## 背景

产品文档要求传统数据库能力必须完整可用。表数据编辑是数据库 IDE 的基本盘，不能依赖 Agent 或前端临时拼接 SQL。用户在表格里修改单元格时，后端必须能生成可审查 SQL，并保证失败时不会留下半提交状态。

## 本次实现

新增 `packages/core-db/src/table-edit.ts`：

- `buildTableEditPreview()`
  - 支持 `insert` / `update` / `delete` 三类表编辑操作。
  - 所有 schema、table、column 都使用 PostgreSQL identifier quote。
  - 字符串、日期、布尔、数字、bigint、JSONB、bytea 都通过统一字面量转换。
  - `update` / `delete` 必须提供完整主键。
  - `update` 禁止修改主键列。
  - `delete` 标记为 `dangerous`。
  - 批量超过阈值时输出 `requiresExtraConfirmation`。

生成的 SQL 仍通过 `PostgresDriver.execute()` 执行。由于多语句和写操作会触发 `requiresConfirmation`，driver 会在可写连接中使用显式事务执行，任意语句失败都会 `ROLLBACK`。

## 用户级场景

已覆盖：

- 用户新增一行、修改一行、删除一行后，后端生成一段可预览 SQL。
- 用户尝试编辑无主键表的已有行时，后端拒绝，避免误更新多行。
- 用户尝试修改主键列时，后端拒绝。
- 用户批量修改超过阈值时，后端要求二次确认。
- 真实 PostgreSQL 集成测试中，成功预览可以提交；后续带重复主键的失败预览会整体回滚。

## 测试

- `vitest run packages/core-db/test --passWithNoTests`
  - 覆盖默认单元测试和环境门控的 PostgreSQL 集成测试文件。
  - 当前默认环境未启用 `DBAGENT_RUN_POSTGRES_TESTS=1`，真实 PG case 默认跳过。
- `packages/core-db/test/postgres.integration.test.ts`
  - 新增真实 PostgreSQL 表编辑提交和失败回滚 case。
  - 需要本机或远程 PostgreSQL 可达后通过 `pnpm test:postgres` 执行。

## 当前环境限制

当前开发机没有 Docker，`127.0.0.1:5432` 不可达，`winget` 静默安装 PostgreSQL 16 超时未完成。因此本次默认验证不能宣称真实 PG 已在当前机器跑通；但真实 PG 测试入口和用例已补齐，满足后续有数据库环境时直接执行。
