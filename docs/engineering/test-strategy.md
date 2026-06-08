# 测试策略

## 测试分层

- 单元测试覆盖纯业务规则，例如 SQL 安全判断、PostgreSQL identifier quote、预览 SQL limit、连接校验、查询历史、CSV/JSON 导出、用量窗口、认证与会话持久化。
- 集成测试覆盖真实 PostgreSQL 行为。本地 fixture 放在 `scripts/dev-db`，自动化入口为 `pnpm test:postgres`，底层由 `scripts/run-postgres-tests.mjs` 设置 `DBAGENT_RUN_POSTGRES_TESTS=1` 后运行 `packages/core-db/test/postgres.integration.test.ts`。
- 远程连接风险以可复现单测覆盖连接建立失败和连接后运行期中断分类，以真实 PostgreSQL 集成测试覆盖成功连接、查询、断连和事务回滚。弱网、VPN、云安全组和跨系统防火墙场景后续进入发布前手工 QA 矩阵。
- E2E 测试覆盖桌面端用户路径：打开应用、创建连接、执行 SQL、查看结果表、查看查询历史、验证只读拦截、导出 CSV、重启后恢复 SQL 草稿。
- Smoke 测试是零外部依赖的仓库健康检查，入口为 `pnpm smoke`，实现文件为 `scripts/smoke.mjs`。它检查关键文件存在、SQL 安全关键字和 IPC 契约片段。

## M0-M1.5 业务场景

- 数据分析师连接 PostgreSQL 并执行安全的 `SELECT`。
- 数据分析师误在只读连接上执行 `DELETE`，应用明确阻止操作。
- 数据分析师在可写连接上执行 `UPDATE`、`DELETE`、DDL 或多语句 SQL 时，主进程必须先返回确认要求；用户确认后才执行。
- 工程师执行语法错误 SQL，看到可理解的错误，同时 SQL 文本不丢失。
- DBA 查看查询历史，包括状态、耗时、行数和安全等级。
- BYOK 用户不登录也能进入应用，本地查询轮次仍会记录。
- 工程师连接 PostgreSQL 后打开 Schema 树，点击表生成安全 quote 的 `select * ... limit 100` 预览查询。
- 工程师点击 Schema 树中的表名时，能看到列、类型、nullable、主键和外键引用；点击 `SQL` 时才生成数据预览查询。
- 数据分析师将结果导出 CSV 或 JSON；CSV 要处理逗号、引号、换行、JSON 和空值，JSON 要保留 metadata、列顺序和安全报告。
- 应用重启后恢复活动连接 id 和 SQL 草稿。
- 用户能编辑已保存连接的 host、database、SSL 和超时配置；更新后连接池必须断开，避免继续使用旧连接。
- 用户能删除已保存连接，同时删除对应凭证和活动连接池。
- 工程师在可写连接上执行批量写入，其中后续语句失败时，前序写入必须回滚。
- 数据分析师执行复杂 SQL 时，系统返回性能提示，例如缺少 `LIMIT`、大 `OFFSET`、前置通配符 `LIKE`、逗号连接和过滤列套函数。
- 用户在本地 Windows 或 Linux 桌面连接服务器上的 PostgreSQL 时，认证失败、DNS 失败、端口关闭、超时和连接中断应被分类成具体错误码。
- 用户创建“电商分析项目”Workspace 后，磁盘上必须出现 `.dbagent/workspace.json`、SQL 库、脚本目录、文档目录和输出目录。
- 用户打开已有 Workspace 后，该项目必须成为最近项目列表的第一项，并在下次启动时恢复为活动项目。
- 用户尝试打开普通目录或损坏 Workspace 时，应用必须返回可处理错误，不能污染最近项目列表。
- 用户能在中文与英文界面之间切换，未知语言配置必须回退到中文。

## 必须通过的质量门禁

当前仓库已有的基础门禁：

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm smoke
pnpm run ci
```

`pnpm run ci` 当前等价于：

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm smoke
```

真实 PostgreSQL 集成测试不放入本地 `pnpm run ci`，避免没有数据库的开发机无法执行；但 GitHub Actions 已有独立 `postgres-integration` job，会启动 PostgreSQL 16 service、加载 `scripts/dev-db/init.sql`，然后运行：

```bash
pnpm test:postgres
```

本地优先使用 Docker：

```bash
pnpm db:up
pnpm test:postgres
pnpm db:down
```

如果本机没有 Docker，也可以使用 PostgreSQL 官方 Windows binary fixture。本次阶段验证在本机下载并解压 PostgreSQL 16.14，初始化本地 `dbagent_demo` 后运行 `pnpm test:postgres`，测试确实连接了 `127.0.0.1:5432` 上的真实 PostgreSQL 进程，而不是 mock。

当前快速测试覆盖：

- `packages/core-db/test/sql-safety.test.ts` 覆盖只读拦截、写操作风险和多语句风险。
- `packages/core-db/test/sql-performance.test.ts` 覆盖复杂 SQL 性能提示。
- `packages/core-db/test/postgres-errors.test.ts` 覆盖远程连接常见失败和连接后运行期失败分类。
- `packages/core-db/test/postgres-driver-runtime-errors.test.ts` 覆盖空 SQL 校验，以及查询执行、Schema 列表和表详情在远程中断/查询错误时不抛出 IPC 外异常。
- `packages/core-db/test/sql-builder.test.ts` 覆盖 PostgreSQL 标识符 quote 和预览 limit 上限。
- `packages/core-db/test/connection-store.test.ts` 覆盖连接持久化、状态更新和损坏 JSON 降级。
- `packages/core-db/test/query-history.test.ts` 覆盖查询历史记录、审计上下文和损坏 JSON 降级。
- `apps/desktop/src/main/connection-validation.test.ts` 覆盖远程连接表单配置校验，例如 SSL、连接超时和语句超时。
- `apps/desktop/src/main/connection-workflow.test.ts` 覆盖连接生命周期：创建连接保存凭证、更新不存在连接不写孤立凭证、更新后断开旧连接池、连接失败标记 error、删除连接时清理凭证。
- `apps/desktop/src/main/credential-vault.test.ts` 覆盖密码凭证保存、读取、删除、`safeStorage` 可用路径和不可用 fallback。
- `apps/desktop/src/main/query-confirmation.test.ts` 覆盖写操作确认握手，确保未确认 SQL 不会直接执行。
- `apps/desktop/src/main/query-workflow.test.ts` 覆盖主进程查询业务链路：安全查询成功入历史和用量、空 SQL 在 driver 前返回校验错误、只读写操作在 driver 前拦截、可写危险 SQL 未确认时要求确认、driver 失败时写失败历史。
- `apps/desktop/src/main/schema-workflow.test.ts` 覆盖 Schema 主进程业务链路：连接不存在时不触碰 driver，连接存在时按保存连接的 `engine` 路由 `listTables` 和 `describeTable`。
- `apps/desktop/src/main/workspace-state-store.test.ts` 覆盖 SQL 草稿恢复、活动连接恢复、缺失文件、损坏 JSON 和结构不合法状态。
- `apps/desktop/src/main/workspace-project-store.test.ts` 覆盖真实项目目录创建、标准模板 starter 文件、打开已有项目、最近项目置顶和普通目录拒绝打开。
- `apps/desktop/src/renderer/src/connection-draft.test.ts` 覆盖已保存连接回填到编辑表单时不回填密码，并保留远程连接配置。
- `apps/desktop/src/renderer/src/diagnostics.test.ts` 覆盖远程连接错误提示和 SQL 性能告警汇总。
- `apps/desktop/src/renderer/src/i18n.test.ts` 覆盖默认中文、英文切换和未知语言回退。
- `packages/shared/test/ipc-contract.test.ts` 覆盖 IPC channel 快照，并用编译期断言保证 request/response map 对齐。
- `packages/shared/test/csv.test.ts` 覆盖真实表格导出边界。
- `packages/shared/test/export.test.ts` 覆盖 JSON 结果导出边界。
- `packages/core-auth/test/auth-service.test.ts` 覆盖认证状态和会话持久化。
- `packages/core-usage/test/usage-tracker.test.ts` 覆盖本地用量记录。

## PostgreSQL 集成验证

本地 PostgreSQL fixture：

```bash
pnpm db:up
```

默认连接：

- Host: `127.0.0.1`
- Port: `5432`
- Database: `dbagent_demo`
- User: `postgres`
- Password: `postgres`

业务检查：

- `PostgresDriver.test(config)` 能连接默认 fixture。
- `PostgresDriver.listTables(connectionId)` 返回 `public.users` 和 `public.orders`。
- `PostgresDriver.describeTable(connectionId, 'public', 'users')` 返回列 metadata 和主键 `id`。
- `PostgresDriver.describeTable(connectionId, 'public', 'orders')` 返回 `user_id -> public.users.id` 外键。
- 真实 join 查询返回 `Shanghai` 和 `Beijing`。
- 只读连接中 `delete from users where email = 'alice@example.com'` 必须返回 `READ_ONLY_VIOLATION`。
- `disconnect(connectionId)` 后再次 `listTables(connectionId)` 必须返回 `CONNECTION_FAILED`。
- `disconnect(connectionId)` 后再次 `describeTable(connectionId, ...)` 必须返回 `CONNECTION_FAILED`。
- 可写连接中批量 SQL 先插入数据、再执行错误语句时必须失败，并且前序插入后的计数仍为 `0`，证明事务已回滚。

环境变量 `DBAGENT_TEST_PG_HOST`、`DBAGENT_TEST_PG_PORT`、`DBAGENT_TEST_PG_DATABASE`、`DBAGENT_TEST_PG_USER` 和 `DBAGENT_TEST_PG_PASSWORD` 可覆盖默认连接。CI 已把 `pnpm test:postgres` 作为独立真实数据库门禁；候选发布仍建议在目标操作系统上额外跑一次本地或远程 PostgreSQL 验证。

## M0-M1.5 发布风险

- Electron 包级测试通过，不等于最终桌面包可启动。主进程、preload、ASAR 路径和运行时依赖必须通过打包产物验证。
- PostgreSQL 自动化集成测试已作为 `pnpm test:postgres` 落地，并在 GitHub Actions `postgres-integration` job 中连接真实 PostgreSQL 16 service；候选发布前仍必须显式确认该 job 通过。
- 远程数据库连接不是单一问题：DNS、端口、防火墙、VPN、SSL、认证、数据库名和连接中断都可能失败。M1.5 已有错误分类和超时/keepalive 默认值，发布 QA 仍需覆盖 Windows 客户端连接 Linux PostgreSQL、Windows 客户端连接 Windows PostgreSQL、Linux 客户端连接 Linux PostgreSQL 等组合。
- Docker Compose、PostgreSQL 测试容器、fixture loader 和 CI helper 不能进入最终应用包。
- `pnpm package` 后必须验证打包产物启动；renderer dev server 或 Vitest 不能替代安装包验证。
- `pnpm package:verify` 是当前平台的标准打包产物验证入口；无图形环境只能运行 `pnpm package:verify:asar` 时，发布记录必须说明没有做启动探活。
- `@dbagent/desktop` 的 Vitest 配置必须同时覆盖 `src/main` 和 `src/renderer`；否则主进程纯逻辑测试会被漏跑。
- 认证和用量持久化要保持快速单测覆盖，因为它们同时影响 BYOK 模式和后续订阅 UX。

候选发布推荐顺序：

```bash
pnpm run ci
pnpm db:up
pnpm test:postgres
pnpm package
pnpm package:verify
pnpm db:down
```

如果跳过 `pnpm test:postgres`，候选发布记录中必须明确原因和替代验证方式。
## 2026-06-08 增量：EXPLAIN 安全测试

本轮补充 `apps/desktop/src/main/explain-workflow.test.ts`，用于覆盖“解释执行计划”这一真实业务路径。重点不是只验证字符串拼接，而是验证 EXPLAIN 不能成为危险 SQL 的绕行入口：

- `SELECT`、`WITH`、`VALUES` 会被包装为 `EXPLAIN (FORMAT JSON)` 并进入普通查询 workflow。
- 空 SQL、多语句 SQL、`UPDATE`、`DROP` 等输入会返回 `VALIDATION_ERROR`。
- 被拒绝的 SQL 不会调用 driver，不会消耗用量，也不会写查询历史。

该测试补齐了 M1.5 SQL 执行链中的一个边界：普通执行走 `query-workflow.test.ts`，解释计划走 `explain-workflow.test.ts`，二者共同保证只读连接、危险 SQL 确认和性能分析入口的行为一致。
