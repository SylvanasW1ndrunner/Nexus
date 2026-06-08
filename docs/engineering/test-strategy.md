# 测试策略

## 测试分层

- 单元测试覆盖纯业务规则，例如 SQL 安全判断、连接校验、用量窗口、认证与会话持久化。
- 集成测试覆盖真实 PostgreSQL 行为；本地或 CI 具备 Docker 后，通过 Docker Compose 启动测试库。
- E2E 测试覆盖桌面端用户路径：打开应用、创建连接、执行 SQL、查看结果表、查看查询历史、验证只读拦截。
- Smoke 测试是零外部依赖的仓库健康检查，即使 Node 包尚未完整安装，也应尽量能运行。

## M1/M1.5 业务场景

- 数据分析师连接 PostgreSQL 并执行安全的 `SELECT`。
- 数据分析师误在只读连接上执行 `DELETE`，应用明确阻止操作。
- 工程师执行语法错误 SQL，看到可理解的错误，同时 SQL 文本不丢失。
- DBA 查看查询历史，包括状态、耗时、行数和安全等级。
- BYOK 用户不登录也能进入应用，本地查询轮次仍会记录。
- 工程师连接 PostgreSQL 后打开 Schema 树，点击表生成安全 quote 的 `select * ... limit 100` 预览查询。
- 数据分析师将结果导出 CSV，逗号、引号、换行、JSON 和空值等表格敏感内容能正确导入。
- 应用重启后恢复活动连接 id 和 SQL 草稿。

## 必须通过的质量门禁

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm smoke
```

当前快速测试覆盖：

- `packages/core-db/test/sql-builder.test.ts` 覆盖 PostgreSQL 标识符 quote 和预览 limit 上限。
- `packages/shared/test/csv.test.ts` 覆盖真实表格导出边界。
- 既有 core 测试覆盖 SQL 安全、连接持久化、查询历史、认证和用量记录。

## M0-M1.5 发布风险

- Electron 包级测试通过，不等于最终桌面包可启动。主进程、preload、ASAR 路径和运行时依赖必须通过打包产物验证。
- PostgreSQL 集成测试必须在候选发布前跑真实数据库。单元测试足够覆盖 SQL 安全和本地持久化 helper，但不能证明驱动行为、SSL 选项、连接池生命周期、结果类型映射或服务器错误文本正确。
- Docker PostgreSQL 测试在本地开发中可先作为 opt-in；等 CI 环境具备 Docker 后，应作为发布 CI 必跑项。
- `pnpm --filter @dbagent/desktop package` 后必须验证打包产物启动；renderer dev server 或 Vitest 不能替代安装包验证。
- 认证和用量持久化要保持快速单测覆盖，因为它们同时影响 BYOK 模式和后续订阅 UX。

候选发布命令：

```bash
pnpm --filter @dbagent/desktop package
```

推荐候选发布顺序：

```bash
pnpm run ci
pnpm --filter @dbagent/core-db test:postgres
pnpm --filter @dbagent/desktop package
```

`test:postgres` 是后续 Docker PostgreSQL 集成测试的目标脚本名。如果脚本尚未实现，候选发布记录中必须明确 PostgreSQL 集成测试未完成。

## PostgreSQL 集成测试数据

M1 手工和自动化集成测试使用 `scripts/dev-db` 中的本地 fixture：

```bash
docker compose -f scripts/dev-db/docker-compose.yml up -d
```

默认连接：

- Host: `127.0.0.1`
- Port: `5432`
- Database: `dbagent_demo`
- User: `postgres`
- Password: `postgres`

业务检查：

- `select * from users` 返回种子用户数据。
- `select u.city, sum(o.total_amount) from users u join orders o on o.user_id = u.id group by u.city` 验证真实 join 场景。
- 只读连接下 `delete from users` 必须被阻止。
