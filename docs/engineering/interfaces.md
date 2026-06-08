# 接口文档

## IPC 边界

Renderer 只能通过 `packages/shared/src/ipc.ts` 中定义的类型化 IPC 契约调用主进程能力。Preload 通过 `window.dbagent.invoke(channel, request)` 暴露统一入口，主进程使用 `ipcMain.handle` 注册同一组 channel。

当前 BetaV0.1.1 channel：

- `connection:list`
- `connection:test`
- `connection:create`
- `connection:update`
- `connection:remove`
- `connection:connect`
- `connection:disconnect`
- `db:execute-query`
- `db:query-history`
- `db:explain-query`
- `db:list-tables`
- `db:describe-table`
- `auth:login`
- `auth:logout`
- `auth:status`
- `usage:current-quota`
- `usage:history`
- `app:load-workspace-state`
- `app:save-workspace-state`
- `workspace:choose-directory`
- `workspace:create`
- `workspace:open`
- `workspace:list-recent`
- `workspace:load-active`
- `workspace:list-files`
- `workspace:save-sql-file`

所有响应统一使用 `packages/shared/src/result.ts` 中的 `Result<T>`，让 UI 显式处理业务失败，而不是捕获无类型异常。

## 数据库驱动边界

`IDatabaseDriver` 是 M1 阶段的稳定边界。当前只实现 PostgreSQL，但接口刻意保持数据库无关：

- `test(config)`：检查连接可达性，返回延迟。
- `connect(config)`：创建或恢复活动连接池。
- `disconnect(connectionId)`：关闭连接池资源。
- `execute(request, connection)`：执行 SQL，并返回字段、行数据、行数、耗时和安全报告。
- `listTables(connectionId)`：为 M1.5 Schema 树和后续 M2 RAG 提供表/视图列表。
- `describeTable(connectionId, schema, table)`：返回表/视图列、类型、nullable、默认值、注释、主键和外键引用。

`PostgresDriver` 使用 `pg`，连接参数由主进程从连接元数据和本地凭证组合生成；renderer 不直接接触驱动实例、连接池或密码。

`DatabaseDriverRegistry` 是多数据库接入的工程入口。默认 registry 只注册 PostgreSQL，但会暴露每个 driver 的 `DatabaseCapabilities`，并由 main 按 `engine` 获取 driver。`get(engine)` 会复用同一个 driver 实例，避免连接池被重复创建；`create(engine)` 只用于需要新实例的测试或隔离场景。后续新增数据库时，先实现新的 `IDatabaseDriver`，再在 registry 注册对应工厂和能力声明；UI、IPC 和查询 workflow 不应直接依赖具体数据库 SDK。

远程数据库连接默认按桌面端真实使用场景处理：连接超时默认为 10 秒，语句超时默认为 60 秒，TCP keepalive 开启。`ConnectionInput`、`SavedConnection` 和 `DatabaseConnectionConfig` 支持 `ssl`、`connectionTimeoutMs` 和 `statementTimeoutMs`，用于跨机房、VPN、堡垒机、云安全组或弱网环境。主进程会校验超时值必须在 `1,000..120,000` 毫秒之间。

PostgreSQL 连接错误会被分类为可展示、可测试的业务错误码：

- `DB_AUTH_FAILED`：用户名、密码或认证方式失败。
- `DB_DATABASE_NOT_FOUND`：目标数据库不存在。
- `DB_HOST_UNRESOLVED`：DNS 或主机名解析失败。
- `DB_PORT_CLOSED`：主机可达但端口未开放、服务未监听或防火墙拒绝连接。
- `DB_CONNECTION_TIMEOUT`：网络链路、VPN、云安全组或数据库侧响应超时。
- `DB_CONNECTION_INTERRUPTED`：连接被远端、代理或网络中间层中断。

这些错误码用于 UI 给出更具体的排查提示，避免把远程连接问题都折叠成笼统的连接失败。连接建立后的查询执行和 Schema 元数据读取也会复用运行期错误分类：远程中断、端口拒绝和超时返回可重试的数据库连接错误；SQL 语法错误、权限错误或 catalog 查询错误返回 `QUERY_FAILED`。

Renderer 通过诊断 helper 将错误码转成用户可行动提示，例如检查 VPN、DNS、防火墙、云安全组、SSL 要求、监听地址和 `pg_hba.conf`。

## 工作区状态

M1.5 通过 `app:load-workspace-state` 和 `app:save-workspace-state` IPC channel 持久化当前活动连接 id 和 SQL 编辑器草稿。

状态文件位于 Electron `userData/data/workspace-state.json`，写入方式为临时文件加 `rename` 的原子写，避免半写入状态。加载时会校验 `sqlDraft` 和 `updatedAt`，并忽略缺失、损坏或结构不合法的状态文件，保证应用启动优先于恢复草稿。当前只保存最小恢复信息，先覆盖日常 SQL 编辑路径；完整 session、tab 和 Agent checkpoint 后续再进入独立存储。

## 连接与凭证

连接元数据和密码分开存储：

- `ConnectionStore` 写入 Electron `userData/data/connections.json`。
- `QueryHistoryStore` 写入 `userData/data/query-history.json`。
- 密码写入 `userData/data/credentials.json`，主进程通过 `CredentialVault` 优先使用 Electron `safeStorage` 加密。`safeStorage` 不可用时会退化为 base64 fallback，保证开发和受限桌面环境仍可运行；该 fallback 不是安全加密，只是 M1.5 阶段的可用性兜底。凭证文件使用临时文件加 rename 原子写入，避免异常退出留下半写 JSON。

`connections.json` 和 `query-history.json` 也使用临时文件加 rename 原子写入。读取时如果文件缺失或 JSON 损坏，会按空列表处理，保证应用启动和查询执行优先于恢复本地辅助数据。

Renderer 在创建连接后不会再收到已保存密码；删除连接时也会删除对应凭证。这是 M1 的过渡实现。公开发布前，应将该边界迁移到 OS keychain adapter 后面，并分别验证 Windows Credential Manager、macOS Keychain 和 Linux secret storage。

更新连接元数据时，主进程会主动断开对应连接池并把状态置为 `disconnected`。这是为了避免用户修改 host、database、SSL 或超时后，界面显示新配置但查询仍落到旧连接池。删除连接会同时断开连接池、删除连接元数据并删除对应凭证。

## SQL 安全

`analyzeSqlSafety(sql, { readOnly })` 会在执行前分类 SQL：

- 空 SQL 或只有注释的 SQL 返回 `VALIDATION_ERROR`，不调用 driver、不写查询历史、不记录用量。
- 只读连接允许 `SELECT`、`WITH`、`SHOW`、`EXPLAIN` 和 `VALUES`。
- 只读连接阻止 `INSERT`、`UPDATE`、`DELETE`、`MERGE`、`CALL` 和 DDL。
- 非只读连接上的写操作和 DDL 需要用户确认。
- 多语句 SQL 需要审查，因为影响范围更大。

主进程会在 `db:execute-query` 边界强制确认握手：当 `QuerySafetyReport.requiresConfirmation` 为 `true` 且 `QueryRequest.confirmed !== true` 时，返回 `CONFIRMATION_REQUIRED`，不执行 SQL，也不写查询历史。Renderer 收到该错误后弹出二次确认；用户确认后用同一 SQL 和 `confirmed: true` 重新提交。

安全报告会写入查询历史，并返回给 renderer。对于已确认的写操作或 DDL，PostgreSQL 驱动会包裹在显式事务中执行：成功后 `COMMIT`，任一语句失败后 `ROLLBACK`，避免批量 SQL 在中途失败时留下半完成状态。

`QuerySafetyReport.performanceWarnings` 会返回轻量 SQL 性能提示，当前覆盖：

- `SELECT_STAR`：探索查询中使用 `SELECT *`。
- `MISSING_LIMIT`：非聚合查询缺少 `LIMIT`。
- `LEADING_WILDCARD_LIKE`：`LIKE '%xxx'` 可能无法使用普通 btree 索引。
- `LARGE_OFFSET`：大 offset 分页可能扫描并丢弃大量行。
- `CARTESIAN_JOIN`：逗号连接可能产生意外笛卡尔积。
- `FUNCTION_ON_FILTER_COLUMN`：过滤列上套函数可能阻止索引使用。

这些提示不阻止执行，只为 M1.5 的结果区和后续 M2 Agent 解释 SQL 风险提供结构化输入。`db:explain-query` 进入独立 `explain-workflow` 校验后，再给单条只读 SQL 添加 `EXPLAIN (FORMAT JSON)`，并复用执行链路和历史记录边界。

## IPC 契约校验

`packages/shared/test/ipc-contract.test.ts` 固化当前 BetaV0.1.1 IPC channel 集合，并用 TypeScript 编译期断言保证 `IpcRequestMap` 与 `IpcResponseMap` 的键集合一致。新增、删除或重命名 channel 时，必须同时更新 `ipcChannels`、request map、response map、主进程 handler、renderer 调用点和该契约测试。

## 工作空间/项目管理

BetaV0.1.1 新增项目级 Workspace IPC，目标是把 SQL、脚本、文档和导出物沉淀到用户选择的真实目录中。

- `workspace:choose-directory`：打开系统目录选择器，返回用户选择的目录路径；取消选择时返回空对象。
- `workspace:create`：按 `WorkspaceCreateRequest` 创建项目目录、`.dbagent/workspace.json` 和标准目录骨架。
- `workspace:open`：读取已有项目目录中的 `.dbagent/workspace.json`，校验后设为最近项目和当前项目。
- `workspace:list-recent`：返回 `userData/data/workspaces.json` 中维护的最近项目列表。
- `workspace:load-active`：加载最近项目中的当前活动项目。
- `workspace:list-files`：列出项目中的 `sql/`、`queries/`、`scripts/`、`docs/`、`outputs/` 核心资产树。
- `workspace:save-sql-file`：将当前 SQL 保存到 Workspace SQL 库，写入 `@name`、`@connection`、`@tags`、`@updated` 等头部元信息。

Workspace 配置采用 `WorkspaceProject` 类型，当前包含 `id`、`name`、`rootPath`、`template`、时间戳、关联连接列表、默认 Agent 模式、启用 Skill/MCP 列表和标签。连接定义仍然是全局资源，Workspace 只保存连接关联关系；凭证不进入项目目录。

主进程实现位于 `apps/desktop/src/main/workspace-project-store.ts`。创建项目时会生成 `.dbagent/`、`sql/`、`scripts/`、`docs/`、`outputs/` 等目录；`standard` 模板还会包含 `queries/`、`skills/`、`notebooks/` 和报告/脚本运行输出子目录。最近项目列表写入 Electron `userData/data/workspaces.json`，不写入用户项目目录。

SQL 文件保存路径当前固定在 `sql/analytics/<slug>.sql`，文件名由用户输入名称 slug 化得到。主进程使用 `resolveInside` 约束写入路径，避免相对路径逃逸 Workspace 根目录。保存内容遵循产品文档中的 SQL 元信息约定，便于后续命令面板、Agent 和 RAG 检索。

## Schema 与 SQL builder

`db:list-tables` 返回 `TableSummary[]`，包含 schema、表/视图名、类型和可选 comment。`db:describe-table` 返回 `TableDetail`，包含 `columns` 和 `primaryKey`，列级 metadata 包括列名、顺序、数据库原生类型、可空性、默认值、注释、是否主键和外键引用。

Renderer 可基于 `buildTablePreviewSql(schema, table, limit)` 生成预览 SQL；该 helper 会 quote PostgreSQL identifier，并将 limit 约束在 `1..1000`。

## 结果导出

`packages/shared/src/csv.ts` 中的 `queryResultToCsv(result)` 将查询结果转换为 CSV，供 Excel/WPS 等表格工具导入。

它会保持数据库返回的列顺序，并处理逗号、引号、换行、JSON 值和 `NULL` 等真实业务数据边界。

`packages/shared/src/export.ts` 中的 `queryResultToJson(result)` 将结果导出为带 metadata 的 JSON：包含 `queryId`、`rowCount`、`elapsedMs`、`columns`、`rows` 和 `safety`。行数据按结果列顺序重建，并把 `Date`、`bigint`、`Buffer` 和嵌套对象转成可序列化 JSON。
## 2026-06-08 增量：EXPLAIN 查询接口边界

`db:explain-query` 不再由 `main.ts` 直接拼接 SQL，而是进入 `apps/desktop/src/main/explain-workflow.ts`。该 workflow 先校验原始 SQL，再把通过校验的单条只读查询转换为 `EXPLAIN (FORMAT JSON) <原 SQL>`，最后复用 `db:execute-query` 的连接、历史、用量和 driver 路径。

M1.5 阶段的接口约束如下：

- 允许：单条 `SELECT`、`WITH`、`VALUES` 查询。
- 拒绝：空 SQL、多语句 SQL、`INSERT`、`UPDATE`、`DELETE`、`MERGE`、`CALL`、DDL 等非只读语句。
- 拒绝结果：返回 `VALIDATION_ERROR`，不进入数据库 driver，也不写查询历史。

这样做的原因是 EXPLAIN 在产品语义上属于“分析查询计划”，不是危险 SQL 的绕行入口。后续接入更多数据库时，每个 driver 可以继续实现自己的 explain 方言，但主进程的安全入口必须保持一致。
