# core-db 数据库核心模块

## 代码入口

- `packages/core-db/src/types.ts`：数据库 driver adapter 接口和通用配置。
- `packages/core-db/src/postgres-driver.ts`：PostgreSQL driver 实现。
- `packages/core-db/src/postgres-errors.ts`：PostgreSQL 连接错误分类。
- `packages/core-db/src/sql-safety.ts`：SQL 安全判断。
- `packages/core-db/src/sql-performance.ts`：轻量性能提示。
- `packages/core-db/src/sql-builder.ts`：Schema 预览 SQL 和 identifier quote。
- `packages/core-db/src/connection-store.ts`：连接元数据持久化。
- `packages/core-db/src/query-history.ts`：查询历史持久化。

## 开发逻辑

`core-db` 负责数据库相关的业务规则，但不负责 UI 和 Electron 生命周期。它的核心抽象是 `IDatabaseDriver`，而不是 ORM。

不用 ORM 的原因是 DBAgent 操作的是用户已有数据库，用户会执行任意 SQL，并且产品需要暴露原生错误、Schema metadata、`EXPLAIN`、权限行为和数据库方言差异。ORM 适合未来管理 DBAgent 自己的本地配置库，不适合作为用户数据库主接入层。

PostgreSQL 当前是第一个 driver。`PostgresDriver` 内部持有连接池，接收主进程提供的完整连接配置，执行后返回结构化列信息、行数据、耗时、行数和安全报告。Renderer 永远不接触 driver、pool、密码或原始数据库连接。

Schema 能力分为轻重两层：`listTables` 只返回表/视图摘要，连接后快速展示；`describeTable` 仅在用户点击具体表时拉取列、主键、外键和注释，避免在大型生产库中一次性扫描过多 catalog。

写操作保护分两层：

- `analyzeSqlSafety` 在执行前识别只读违规、写操作、DDL 和多语句。
- 对需要确认的 SQL，主进程必须完成确认握手后才调用 driver。driver 在可写连接中使用显式事务执行需要确认的 SQL，任意语句失败都 `ROLLBACK`，避免批量 SQL 留下半完成状态。

远程连接按真实桌面使用场景处理：默认连接超时、语句超时、TCP keepalive，并把认证失败、DNS 失败、端口关闭、超时和连接中断分类成产品错误码。这样 Windows 或 Linux 桌面连接服务器数据库时，用户能得到可操作提示，而不是只有“连接失败”。

性能提示是轻量静态分析，不阻塞执行。当前覆盖 `SELECT *`、缺少 `LIMIT`、前置通配 `LIKE`、大 `OFFSET`、逗号连接和过滤列套函数。它不是优化器替代品，而是 M1.5 阶段给用户和后续 Agent 的结构化风险输入。

## 测试覆盖

- `sql-safety.test.ts`：只读拦截、写操作风险、多语句风险。
- `sql-performance.test.ts`：复杂 SQL 性能提示。
- `sql-builder.test.ts`：PostgreSQL identifier quote 和预览 limit 上限。
- `postgres-errors.test.ts`：远程连接常见失败分类。
- `connection-store.test.ts`：连接元数据持久化和删除。
- `query-history.test.ts`：查询历史写入与读取。
- `postgres.integration.test.ts`：真实 PostgreSQL 连接、Schema 列表、表详情、join 查询、只读拦截、断连后失败、批量 SQL 事务回滚。

本地真实数据库验证入口是：

```bash
pnpm test:postgres
```

该命令需要可连接的 PostgreSQL，默认连接 `127.0.0.1:5432/dbagent_demo`，用户名和密码均为 `postgres`。本轮开发已在本机 PostgreSQL 16.14 上实际执行，不是 mock。

## 后续扩展

- 新增数据库时实现新的 `IDatabaseDriver`，例如 `MysqlDriver`、`ClickHouseDriver`、`SqlServerDriver`。
- 每个 driver 独立处理系统表查询、表结构详情、错误分类、`EXPLAIN` 语法、SSL 和连接参数。
- 通用 SQL 安全与性能规则保留在 `core-db` 公共层；数据库方言差异通过 driver capability 暴露。
