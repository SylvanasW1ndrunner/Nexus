# core-db 数据库核心模块

## 代码入口

- `packages/core-db/src/types.ts`：数据库 driver adapter 接口和通用配置。
- `packages/core-db/src/postgres-driver.ts`：PostgreSQL driver 实现。
- `packages/core-db/src/database-driver-registry.ts`：多数据库 driver 注册表和默认 PostgreSQL 工厂。
- `packages/core-db/src/postgres-errors.ts`：PostgreSQL 连接错误分类。
- `packages/core-db/src/sql-safety.ts`：SQL 安全判断。
- `packages/core-db/src/sql-performance.ts`：轻量性能提示。
- `packages/core-db/src/sql-builder.ts`：Schema 预览 SQL 和 identifier quote。
- `packages/core-db/src/table-edit.ts`：表数据编辑的 SQL 预览、主键保护、批量确认和事务执行输入。
- `packages/core-db/src/connection-store.ts`：连接元数据持久化。
- `packages/core-db/src/query-history.ts`：查询历史持久化。
- `packages/core-db/src/query-snapshot.ts`：查询结果快照持久化，用于“钉住结果”和重启后复查。
- `packages/core-db/src/json-file.ts`：JSON 文件原子读写 helper。

## 开发逻辑

`core-db` 负责数据库相关的业务规则，但不负责 UI 和 Electron 生命周期。它的核心抽象是 `IDatabaseDriver`，而不是 ORM。

不用 ORM 的原因是 DBAgent 操作的是用户已有数据库，用户会执行任意 SQL，并且产品需要暴露原生错误、Schema metadata、`EXPLAIN`、权限行为和数据库方言差异。ORM 适合未来管理 DBAgent 自己的本地配置库，不适合作为用户数据库主接入层。

PostgreSQL 当前是第一个 driver。`PostgresDriver` 内部持有连接池，接收主进程提供的完整连接配置，执行后返回结构化列信息、行数据、耗时、行数和安全报告。Renderer 永远不接触 driver、pool、密码或原始数据库连接。

多数据库扩展通过 `DatabaseDriverRegistry` 落地，而不是让 main 或 renderer 直接 new 具体 SDK。默认 registry 注册 PostgreSQL 的 factory 和 capability；`get(engine)` 会缓存并复用同一 engine 的 driver 实例，使连接池生命周期稳定。后续新增 MySQL、ClickHouse 或 SQL Server 时，只需要实现新的 `IDatabaseDriver` 并登记到 registry。这样查询 workflow、历史记录、安全报告、导出和 UI 可以继续依赖统一接口，同时保留各数据库的方言差异和能力声明。

Schema 能力分为轻重两层：`listTables` 只返回表/视图摘要，连接后快速展示；`describeTable` 仅在用户点击具体表时拉取列、主键、外键和注释，避免在大型生产库中一次性扫描过多 catalog。

写操作保护分两层：

- `analyzeSqlSafety` 在执行前识别只读违规、写操作、DDL 和多语句。
- 对需要确认的 SQL，主进程必须完成确认握手后才调用 driver。driver 在可写连接中使用显式事务执行需要确认的 SQL，任意语句失败都 `ROLLBACK`，避免批量 SQL 留下半完成状态。

表数据编辑使用独立的 `buildTableEditPreview()` 生成可审查 SQL，而不是让 UI 直接拼接语句。它覆盖三类操作：

- `insert`：允许无主键表插入，但仍标记为需要确认的写操作。
- `update`：必须提供完整主键，`WHERE` 只由主键生成，禁止通过单元格编辑修改主键列。
- `delete`：必须提供完整主键，风险级别标记为 `dangerous`。

超过默认 50 条操作的批量编辑会标记 `requiresExtraConfirmation`，用于后续 UI 做二次确认。生成出的多语句 SQL 交给 `PostgresDriver.execute()` 后会被 `analyzeSqlSafety` 识别为多语句写操作，并在 driver 层进入事务；任何中间语句失败都会回滚，满足产品文档中“预览 SQL → 确认 → 事务执行 → 失败自动回滚”的表格编辑流程。

远程连接按真实桌面使用场景处理：默认连接超时、语句超时、TCP keepalive，并把认证失败、DNS 失败、端口关闭、超时和连接中断分类成产品错误码。这样 Windows 或 Linux 桌面连接服务器数据库时，用户能得到可操作提示，而不是只有“连接失败”。
连接建立后的运行期错误也必须保持 `Result<T>` 契约。`PostgresDriver.execute`、`listTables` 和 `describeTable` 会把网络中断、端口拒绝和超时继续分类为可重试的远程连接错误；普通 SQL 语法错误、catalog 查询错误等则返回 `QUERY_FAILED`。这保证 Schema 树刷新或查询执行遇到远程数据库抖动时，不会把异常漏到 IPC 外层。

性能提示是轻量静态分析，不阻塞执行。当前覆盖 `SELECT *`、缺少 `LIMIT`、前置通配 `LIKE`、大 `OFFSET`、逗号连接和过滤列套函数。它不是优化器替代品，而是 M1.5 阶段给用户和后续 Agent 的结构化风险输入。

连接元数据和查询历史使用 `json-file.ts` 做临时文件加 rename 的原子写入。读取时如果文件缺失或 JSON 损坏，会返回空列表，让应用继续启动和执行查询；这避免单个损坏的本地 JSON 文件把桌面应用整体拖垮。后续如果进入多用户或大历史量阶段，应迁移到 SQLite 并保留迁移备份。

结果快照由 `QuerySnapshotStore` 管理，服务于产品文档中的“查询结果可钉住，重启后保留”。快照保存 SQL、连接、列信息、行数据、耗时、安全报告、标签、备注和来源历史 ID。列表接口默认只返回前 5 行 `previewRows`，完整内容通过 `get(id)` 获取，避免快照列表页或后续 IPC 一次性搬运大结果集。

快照写入前会显式规范化数据库值：`bigint`、`Date`、`Buffer`、非有限数字、JSONB/数组会转换成稳定 JSON 结构，避免真实 PostgreSQL 结果因为 `bigint` 无法 `JSON.stringify` 而写入失败。快照文件损坏时按空列表降级，保证 IDE 仍可继续执行查询；默认最多保留 200 条，后续如果支持大规模审计或团队协作，应迁移到 SQLite 并增加分页索引。

## 测试覆盖

- `sql-safety.test.ts`：只读拦截、写操作风险、多语句风险。
- `sql-performance.test.ts`：复杂 SQL 性能提示。
- `sql-builder.test.ts`：PostgreSQL identifier quote 和预览 limit 上限。
- `table-edit.test.ts`：表格编辑 SQL 预览、identifier quote、字符串/JSON/bytea 等字面量处理、无主键拒绝更新/删除、主键列不可编辑、批量二次确认。
- `database-driver-registry.test.ts`：driver 注册、能力声明、默认 PostgreSQL 工厂、driver 复用和未注册 engine 错误。
- `postgres-errors.test.ts`：远程连接常见失败和连接后运行期失败分类。
- `postgres-driver-runtime-errors.test.ts`：验证空 SQL 返回输入校验错误，并验证 `execute`、`listTables` 和 `describeTable` 遇到远程中断或查询错误时仍返回 `Result`，不向上抛出异常。
- `connection-store.test.ts`：连接元数据持久化、状态更新和损坏 JSON 降级。
- `query-history.test.ts`：查询历史写入、读取、审计上下文和损坏 JSON 降级。
- `query-snapshot.test.ts`：结果快照钉住、特殊数据库值序列化、连接过滤、搜索、预览行、删除、容量上限和损坏 JSON 降级。
- `postgres.integration.test.ts`：真实 PostgreSQL 连接、Schema 列表、表详情、join 查询、只读拦截、断连后失败、批量 SQL 事务回滚、表编辑 SQL 预览提交和失败回滚。

本地真实数据库验证入口是：

```bash
pnpm test:postgres
```

该命令需要可连接的 PostgreSQL，默认连接 `127.0.0.1:5432/dbagent_demo`，用户名和密码均为 `postgres`。
如果当前机器没有 Docker、本机 PostgreSQL 或可访问的远程测试库，该命令会在 TCP 探测阶段失败；这时默认 `vitest` 仍会运行单元测试，但真实数据库行为不能据此宣称已验证。

## 后续扩展

- 新增数据库时实现新的 `IDatabaseDriver`，例如 `MysqlDriver`、`ClickHouseDriver`、`SqlServerDriver`。
- 在 `DatabaseDriverRegistry` 中登记新 driver 的工厂和 capability；上层只按 `engine` 选择并复用 driver，不直接依赖数据库 SDK。
- 每个 driver 独立处理系统表查询、表结构详情、错误分类、`EXPLAIN` 语法、SSL 和连接参数。
- 通用 SQL 安全与性能规则保留在 `core-db` 公共层；数据库方言差异通过 driver capability 暴露。
