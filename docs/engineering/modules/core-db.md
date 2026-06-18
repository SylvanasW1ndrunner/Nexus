# core-db 数据库核心模块

## 代码入口

- `packages/core-db/src/types.ts`：数据库 driver adapter 接口和通用配置。
- `packages/core-db/src/postgres-driver.ts`：PostgreSQL driver 实现。
- `packages/core-db/src/database-driver-registry.ts`：多数据库 driver 注册表和默认 PostgreSQL 工厂。
- `packages/core-db/src/postgres-errors.ts`：PostgreSQL 连接错误分类。
- `packages/core-db/src/sql-safety.ts`：SQL 安全判断。
- `packages/core-db/src/sql-execution-plan.ts`：执行前预审计划，整合安全、确认、事务、回滚和 EXPLAIN 建议。
- `packages/core-db/src/sql-performance.ts`：轻量性能提示。
- `packages/core-db/src/sql-builder.ts`：Schema 预览 SQL、表数据浏览 SQL、identifier quote 和参数化筛选构建。
- `packages/core-db/src/table-edit.ts`：表数据编辑的 SQL 预览、主键保护、批量确认和事务执行输入。
- `packages/core-db/src/table-designer.ts`：表设计器 DDL 预览，覆盖新建表、添加字段、索引、外键和注释。
- `packages/core-db/src/sql-object-preview.ts`：视图、函数、存储过程的 DDL 预览、删除预览和测试调用 SQL 生成。
- `packages/core-db/src/index-preview.ts`：独立索引管理 DDL 预览，覆盖创建索引、部分索引、表达式索引、并发创建和删除索引。
- `packages/core-db/src/privilege-preview.ts`：PostgreSQL 角色、角色成员关系和对象权限的 GRANT/REVOKE/ROLE DDL 预览。
- `packages/core-db/src/privilege-snapshot.ts`：权限快照差异计划，把当前/目标角色和权限快照转换成最小 SQL 变更计划。
- `packages/core-db/src/explain-plan.ts`：PostgreSQL `EXPLAIN (FORMAT JSON)` 结果分析，把原始计划转换为稳定树、扁平节点和性能 warning。
- `packages/core-db/src/import-plan.ts`：导入向导后端合同，覆盖 CSV/JSON 预览、字段映射和批量 INSERT/UPSERT 计划。
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

执行前预审使用 `buildSqlExecutionPlan()`。该模块把 `analyzeSqlSafety()`、性能提示、连接只读状态、事务能力和 EXPLAIN 能力整合成稳定计划，供 Agent、IPC service 和未来 UI 在执行前统一判断：

- `decision`：`execute`、`requires-confirmation` 或 `blocked`。
- `transactionPolicy`：`none`、`recommended`、`required` 或 `unavailable`。
- `rollbackAvailable`：调用方是否可以承诺失败回滚。
- `shouldExplainBeforeRun`：宽泛读查询是否建议先运行 EXPLAIN。
- `confirmationReasons` / `executionNotes`：给用户和 Agent 展示的审查理由。

`UPDATE` / `DELETE` 没有 `WHERE` 会被标记为 `dangerous`，即使连接可写也必须确认，并在支持事务时要求事务执行。这样用户或 Agent 在误写“全表更新/删除”时，会先收到明确风险，而不是只看到普通写操作确认。

表数据编辑使用独立的 `buildTableEditPreview()` 生成可审查 SQL，而不是让 UI 直接拼接语句。它覆盖三类操作：

- `insert`：允许无主键表插入，但仍标记为需要确认的写操作。
- `update`：必须提供完整主键，`WHERE` 只由主键生成，禁止通过单元格编辑修改主键列。
- `delete`：必须提供完整主键，风险级别标记为 `dangerous`。

超过默认 50 条操作的批量编辑会标记 `requiresExtraConfirmation`，用于后续 UI 做二次确认。生成出的多语句 SQL 交给 `PostgresDriver.execute()` 后会被 `analyzeSqlSafety` 识别为多语句写操作，并在 driver 层进入事务；任何中间语句失败都会回滚，满足产品文档中“预览 SQL → 确认 → 事务执行 → 失败自动回滚”的表格编辑流程。

表设计器使用 `buildCreateTablePreview()` 和 `buildAlterTablePreview()` 生成 DDL 预览。它的边界是“只生成可审查 SQL，不直接执行”，以满足产品文档中“所有变更不直接执行，先生成 DDL 让用户预览”的安全机制。当前支持：

- 新建表：字段、主键、表注释、列注释、索引、外键。
- 修改表：新增字段、新增索引、新增外键、更新表注释。
- PostgreSQL 索引类型：btree、hash、gin、gist、brin。
- 外键动作：no action、restrict、cascade、set null、set default。

DDL 预览默认 `riskLevel` 为 `dangerous`，`requiresConfirmation` 为 `true`，调用方必须让用户确认后才能交给 driver 执行。新建表没有主键时会返回 warning，因为后续表数据编辑无法安全按主键定位行。字段类型允许 `varchar(255)`、`numeric(10,2)` 等正常类型表达，但会拒绝包含 `;` 或 `--` 的明显危险 token；默认值和 check 表达式属于 SQL 片段，后续 UI/Agent 必须显示给用户审查。

视图、函数和存储过程编辑使用 `sql-object-preview.ts` 生成 SQL 对象预览。该模块的边界同样是“生成可审查 SQL，不直接执行”。当前支持：

- `buildCreateOrReplaceViewPreview()`：把单条 `SELECT` 或 `WITH` 查询包装成 `CREATE OR REPLACE VIEW`，支持 `LOCAL` / `CASCADED CHECK OPTION`。
- `buildCreateOrReplaceFunctionPreview()`：生成 PostgreSQL `CREATE OR REPLACE FUNCTION`，支持参数、返回类型、语言、稳定性、`SECURITY INVOKER/DEFINER` 和函数体。
- `buildCreateOrReplaceProcedurePreview()`：生成 PostgreSQL `CREATE OR REPLACE PROCEDURE`，支持 `IN`、`OUT`、`INOUT`、`VARIADIC` 参数。
- `buildDropSqlObjectPreview()`：生成视图、函数、过程的删除预览；函数和过程可通过签名定位重载版本。
- `buildRoutineTestCall()`：为函数/过程测试调用生成参数化 SQL。函数默认走 `SELECT * FROM fn($1...) LIMIT n`，标量函数可走 `SELECT fn($1) AS value`，过程走 `CALL proc($1...)`。

所有对象 DDL 预览都标记为 `dangerous` 且 `requiresConfirmation=true`，调用方必须在用户确认后才能执行。视图定义会拒绝非 `SELECT/WITH` 开头和多语句输入，避免用户在“视图编辑”入口中误执行 DML/DDL。函数/过程的参数类型、返回类型、语言名会做轻量 SQL token 检查；函数体使用 `$dbagent$` delimiter 包装，并拒绝正文包含保留 delimiter，避免生成不可解析的 SQL。测试调用始终使用 `$1`、`$2` 参数占位，不把用户输入值拼入 SQL 文本。

索引管理使用 `index-preview.ts` 生成独立索引 DDL。它补足表设计器里“随表创建/修改”的简单索引能力，服务于产品文档中的索引列表和新建索引对话框。当前支持：

- `buildCreateIndexPreview()`：生成 `CREATE [UNIQUE] INDEX [CONCURRENTLY]`，支持 btree、hash、gin、gist、brin。
- 支持普通列索引、列排序、`NULLS FIRST/LAST`、operator class、表达式索引和部分索引 `WHERE`。
- `buildDropIndexPreview()`：生成 `DROP INDEX`，支持 `CONCURRENTLY`、`IF EXISTS` 和 `CASCADE`。

索引 DDL 同样只生成预览，不直接执行。所有索引变更标记为 `dangerous` 并要求确认。`CONCURRENTLY` 会返回 warning，因为 PostgreSQL 不允许它在显式事务块内执行；`DROP INDEX CONCURRENTLY` 与 `CASCADE` 的非法组合会在预览阶段直接拒绝。部分索引 WHERE 和表达式索引属于 SQL 片段，模块会拒绝多语句和注释 token，但仍要求调用方完整展示给用户审查。

用户与权限管理使用 `privilege-preview.ts` 生成角色与权限变更预览，覆盖产品文档中的“所有变更生成 GRANT/REVOKE 预览”和“危险操作双重确认”。当前支持：

- `buildCreateRolePreview()`、`buildAlterRolePreview()`、`buildDropRolePreview()`：生成角色创建、属性修改和删除预览。
- `buildGrantRoleMembershipPreview()`、`buildRevokeRoleMembershipPreview()`：生成角色成员关系授权/撤销预览。
- `buildGrantPrivilegesPreview()`、`buildRevokePrivilegesPreview()`：生成 schema、table、sequence、function、procedure 对象权限授权/撤销预览。

所有权限变更均标记为 `dangerous` 并要求确认。`SUPERUSER`、`REPLICATION`、`BYPASSRLS`、`WITH ADMIN OPTION`、`WITH GRANT OPTION` 和 `DROP ROLE` 会标记 `requiresExtraConfirmation=true`。该模块不会把密码写入 SQL 预览；未来创建登录用户时，密码应由主进程通过安全输入和凭证边界单独处理，避免明文进入 renderer、日志、测试快照或提交记录。

权限快照差异由 `privilege-snapshot.ts` 处理。它接收 `current` 和 `desired` 两份快照，输出：

- `preChangeSnapshot`：执行前快照，调用方必须持久化后再执行变更。
- `statements`：由 `privilege-preview.ts` 生成的可审查 SQL。
- `changes`：结构化变更列表，说明是角色属性、角色成员关系还是对象权限变化。
- `requiresConfirmation` / `requiresExtraConfirmation`：供后续 UI/Agent 做确认门控。

该模块不负责从数据库采集权限；后续 PostgreSQL driver 应通过 `pg_roles`、`pg_auth_members`、`information_schema.role_table_grants`、`information_schema.routine_privileges` 等系统视图生成快照。当前切片先保证“当前权限备份 → 差异计划 → GRANT/REVOKE 预览”的核心业务逻辑可测。

查询计划分析使用 `explain-plan.ts` 解析 PostgreSQL `EXPLAIN (FORMAT JSON)` 的原始 JSON。它不负责执行 EXPLAIN；执行入口仍由主进程 `explain-workflow.ts` 包装只读 SQL 后走正常查询 workflow。该模块负责：

- 兼容 PostgreSQL FORMAT JSON 数组和查询结果中的 `QUERY PLAN` 单元格形态。
- 生成稳定的树形节点 `ExplainPlanNode`，保留 node type、relation、index、filter、cost、actual time、rows 等核心指标。
- 生成扁平节点列表，方便后续 UI 做树视图、节点搜索、火焰图或 Agent 逐节点引用。
- 生成性能 warning：顺序扫描、高估算成本、高实际耗时、大量过滤、嵌套循环大输入、排序溢出风险。

该模块的目标不是替代 PostgreSQL 优化器，而是把计划解释成产品可消费的结构。后续 AI 解读按钮可以把 `ExplainPlanAnalysis` 作为输入，而不是把原始 JSON 直接塞给模型。

远程连接按真实桌面使用场景处理：默认连接超时、语句超时、TCP keepalive，并把认证失败、DNS 失败、端口关闭、超时和连接中断分类成产品错误码。这样 Windows 或 Linux 桌面连接服务器数据库时，用户能得到可操作提示，而不是只有“连接失败”。
连接建立后的运行期错误也必须保持 `Result<T>` 契约。`PostgresDriver.execute`、`listTables` 和 `describeTable` 会把网络中断、端口拒绝和超时继续分类为可重试的远程连接错误；普通 SQL 语法错误、catalog 查询错误等则返回 `QUERY_FAILED`。这保证 Schema 树刷新或查询执行遇到远程数据库抖动时，不会把异常漏到 IPC 外层。

性能提示是轻量静态分析，不阻塞执行。当前覆盖 `SELECT *`、缺少 `LIMIT`、前置通配 `LIKE`、大 `OFFSET`、逗号连接和过滤列套函数。它不是优化器替代品，而是 M1.5 阶段给用户和后续 Agent 的结构化风险输入。

表数据浏览使用 `buildTableDataQuery()` 生成后端合同，而不是让 UI 拼 SQL。它支持可见列、筛选、排序、分页和高级 WHERE：

- 可见列、schema、table、排序列全部通过 PostgreSQL identifier quote。
- 普通筛选值全部放入 `params`，生成 `$1`、`$2` 等占位符，避免把用户输入直接拼进 SQL。
- 支持 `=`, `!=`, `>`, `>=`, `<`, `<=`, `LIKE`, `NOT LIKE`, `IN`, `NOT IN`, `BETWEEN`, `IS NULL`, `IS NOT NULL`。
- 默认分页 100 行，最大 1000 行，offset 最大 1,000,000；超出范围会产生 warning 并 clamp。
- 高级 WHERE 会原样追加，并返回 warning，后续 UI/Agent 必须把它视为需要审查的 SQL。

`QueryRequest` 已支持 `params`，`PostgresDriver.execute()` 会把参数传给 `pg` 的 query API。这样表数据浏览、筛选搜索和后续参数化 SQL 工具可以走同一条执行通路，避免“构建器安全、执行器不支持”的断层。

导入向导使用 `parseCsvImportPreview()`、`parseJsonImportPreview()` 和 `buildImportExecutionPlan()` 拆成“预览”和“执行计划”两步。预览阶段只解析源数据前 N 行并给出列名、行号、总行数、是否截断和 warning；执行计划阶段根据字段映射生成参数化批量 SQL：

- 当前源格式：CSV、JSON。Excel、SQL 文件后续通过 provider 扩展。
- 执行模式：INSERT、UPSERT、TRUNCATE 后 INSERT。
- 支持字段映射、默认值、空值跳过、批大小、单事务/分批事务、错误处理策略声明。
- 批量 SQL 使用 `$1`、`$2` 参数占位，导入值不直接拼进 SQL 文本。
- `truncate-insert` 会把 `TRUNCATE` 放入 `preludeSql`，由调用方在用户确认后按事务策略执行。

该模块仍然不直接访问文件系统或数据库；主进程/CLI/测试读取文件内容后调用它生成计划，再交给 driver 执行。这样导入向导可以在没有最终 UI 的阶段做完整用户流程测试。

连接元数据和查询历史使用 `json-file.ts` 做临时文件加 rename 的原子写入。读取时如果文件缺失或 JSON 损坏，会返回空列表，让应用继续启动和执行查询；这避免单个损坏的本地 JSON 文件把桌面应用整体拖垮。后续如果进入多用户或大历史量阶段，应迁移到 SQLite 并保留迁移备份。

查询历史由 `QueryHistoryStore` 管理，当前支持两种读取合同：

- `list(options)`：兼容旧调用方，返回历史数组，默认最新优先。
- `search(options)`：面向后续历史面板、Agent 历史读取和事故审计，返回 `{ items, total, offset, limit }`。

检索条件包括连接 ID、SQL / 错误 / 安全原因全文搜索、执行状态、风险级别、语句类型、创建时间范围、分页 offset 和 limit。`db:query-history` IPC 请求类型已同步扩展这些字段，但响应仍保持 `QueryHistoryItem[]`，避免破坏现有调用方。该模块只负责本地历史检索，不直接执行 SQL，也不读取数据库凭据。

结果快照由 `QuerySnapshotStore` 管理，服务于产品文档中的“查询结果可钉住，重启后保留”。快照保存 SQL、连接、列信息、行数据、耗时、安全报告、标签、备注和来源历史 ID。列表接口默认只返回前 5 行 `previewRows`，完整内容通过 `get(id)` 获取，避免快照列表页或后续 IPC 一次性搬运大结果集。

快照写入前会显式规范化数据库值：`bigint`、`Date`、`Buffer`、非有限数字、JSONB/数组会转换成稳定 JSON 结构，避免真实 PostgreSQL 结果因为 `bigint` 无法 `JSON.stringify` 而写入失败。快照文件损坏时按空列表降级，保证 IDE 仍可继续执行查询；默认最多保留 200 条，后续如果支持大规模审计或团队协作，应迁移到 SQLite 并增加分页索引。

## 测试覆盖

- `sql-safety.test.ts`：只读拦截、写操作风险、多语句风险。
- `sql-execution-plan.test.ts`：执行前计划、确认要求、事务/回滚策略、只读阻断、无事务能力 warning 和 EXPLAIN 建议。
- `sql-performance.test.ts`：复杂 SQL 性能提示。
- `sql-builder.test.ts`：PostgreSQL identifier quote、预览 limit 上限、表数据浏览列选择/筛选/排序/分页、用户输入参数化、高级 WHERE warning。
- `table-edit.test.ts`：表格编辑 SQL 预览、identifier quote、字符串/JSON/bytea 等字面量处理、无主键拒绝更新/删除、主键列不可编辑、批量二次确认。
- `table-designer.test.ts`：表设计器 CREATE/ALTER DDL 预览、注释转义、索引、外键、无主键提示和非法定义拦截。
- `sql-object-preview.test.ts`：视图、函数、过程的 DDL 预览、危险视图定义拦截、函数/过程片段校验、参数化测试调用、limit clamp 和删除预览。
- `index-preview.test.ts`：索引管理 CREATE/DROP DDL 预览、并发索引 warning、唯一部分索引、表达式索引、危险 SQL 片段拦截和 PostgreSQL 非法组合拦截。
- `privilege-preview.test.ts`：角色创建/修改/删除、角色成员授权/撤销、对象权限 GRANT/REVOKE、高危权限二次确认、明文密码不入 SQL 和非法权限组合拦截。
- `privilege-snapshot.test.ts`：权限快照 diff、执行前快照保留、角色/成员/对象权限最小变更计划、无变化 plan 和非法权限传播。
- `explain-plan.test.ts`：PostgreSQL JSON 计划树规范化、`QUERY PLAN` 单元格兼容、性能 warning 生成和非法 EXPLAIN payload 拦截。
- `import-plan.test.ts`：CSV/JSON 预览、字段映射、批量 INSERT、UPSERT、TRUNCATE prelude、跳过错误策略 warning 和非法源/计划拦截。
- `database-driver-registry.test.ts`：driver 注册、能力声明、默认 PostgreSQL 工厂、driver 复用和未注册 engine 错误。
- `postgres-errors.test.ts`：远程连接常见失败和连接后运行期失败分类。
- `postgres-driver-runtime-errors.test.ts`：验证空 SQL 返回输入校验错误，参数化查询会传给 PostgreSQL pool，并验证 `execute`、`listTables` 和 `describeTable` 遇到远程中断或查询错误时仍返回 `Result`，不向上抛出异常。
- `connection-store.test.ts`：连接元数据持久化、状态更新和损坏 JSON 降级。
- `query-history.test.ts`：查询历史写入、读取、按 SQL / 错误 / 安全原因搜索、按连接 / 状态 / 风险 / 语句类型筛选、分页元数据、时间范围检索、审计上下文和损坏 JSON 降级。
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
