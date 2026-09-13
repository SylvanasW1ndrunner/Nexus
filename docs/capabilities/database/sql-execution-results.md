# Database Capability：SQL 执行与结果

本文描述内部 Capability 实现与测试，不代表终端已有数据库连接或 SQL 分析入口。

## 功能

Database Capability 为 Agent 提供按需发现的 SQL 工具，包括生成、执行、解释与 Schema 检索。SQL
先经解析得到数据库专用的动作分类，再把动作、风险和已解析资源事实传给统一 Tool Invocation
权限管线。执行结果同时有受限的模型投影和可持久访问的 Result Handle：调用方可分页读取、流式读取、
释放，或导出 CSV/JSONL Artifact。

SQL 分类使用 `query`、`mutation` 与 `schema-admin` 等数据库术语。复合语句按其中最高风险类别处理；
统一权限管线根据动作、效果、危险等级和资源事实，再结合 Agent 的 `default`、`auto` 或
`full-access` 模式以及全局 `allow`/`ask`/`deny` 规则作决定。数据库只读 Profile 仍由执行层施加
只读约束；它不是 Agent 权限模式。

## 设计

`sql_execute` 的 mutation 或 schema-admin 操作被标识为非幂等，并使用该次工具调用的授权/审批事实。
模块把已解析的动作、风险和资源事实传入 `QueryAuthorization`；并不让模型自行声明数据库权限。SQL
安全分析、连接器能力和 PostgreSQL 执行计划在 `core-db` 内完成。

模型投影对行数、预览行和文本大小设上限，供对话继续推理；完整或较大的数据放在 `ResultHandle`。`ProjectDatabaseResultStore` 用项目级持久存储保存结果元数据和分块内容，Handle、分页 cursor 与导出 Artifact 可以在运行时重开后继续解析。结果可能过期、被释放或受保留策略回收，调用方必须处理相应的 typed failure。

SQL 工具执行时持有其 active binding 的读栅栏。重连、断连和切换是写栅栏：已开始的执行可完成，后到的旧 generation 不能跨越迁移并误投递到新 session。退休 binding 返回可重试的 `CONNECTION_FAILED`。

## 效果与边界

- 这是数据库 Capability 的工具合同，而非 Agent 内核内置 SQL 通道。
- 当前 SQL dialect 明确为 PostgreSQL；不承诺 MySQL、SQLite 或其他方言的执行可用。
- `sql_explain` 返回 PostgreSQL JSON 计划，不等于执行写操作；实际语句是否可执行仍取决于权限、Profile、连接器能力和数据库服务端。
- `ResultHandle` 指向持久数据平面，不保证无限保留；`releaseResult` 与垃圾回收可以使后续读取不可用。
- DDL 的 SQL 成功与 Schema 目录刷新是两个事实：刷新失败不会回滚已成功的 DDL，也不会输出“不要重试”一类模型行为指令。

## 场景

1. 模型调用 `sql_execute`。解析器将 `SELECT` 判为 `query`，将数据修改判为 `mutation`，将 DDL、授权等高风险语句判为 `schema-admin`；统一权限管线根据这些事实、Agent 模式和不可被项目覆盖的全局规则决定是否执行。
2. 查询返回大量结果。模型拿到有界列/行预览；完整结果保留在 Capability 的内部持久存储中，不通过当前终端提供 SDK 或 HTTP 读取接口。
3. 进程重开后，内部 Result Store 仍可解析已持久化的分块结果或已生成的导出 Artifact；其读取方式不构成当前公开接入层。
4. DDL 成功后模块尝试重建并发布 Schema generation。若该步骤失败，执行结果仍为成功，并带目录可能滞后的事实提示。
5. 查询执行中发起重连：迁移等待现有查询完成；迁移排队后的旧 Tool generation 不会被提交到新 session。

## 代码与测试

- [AI SQL 工具、权限校验与有界模型投影](../../../packages/database-capability/src/ai-sql-tools.ts)
- [数据库 Capability 查询执行与 binding 栅栏](../../../packages/database-capability/src/database-capability-module.ts)
- [SQL 解析与权限分级](../../../packages/core-db/src/sql-parser.ts)
- [SQL 安全分析](../../../packages/core-db/src/sql-safety.ts)
- [持久结果存储](../../../packages/core-db/src/project-result-store.ts)
- [共享查询、授权与 Result Handle 合同](../../../packages/shared/src/contracts/database.ts)
- [SQL 执行、审批、DDL 与恢复测试](../../../packages/database-capability/test/ai-sql-invocation-runtime.test.ts)
- [结果重开、分页与导出测试](../../../packages/core-db/test/result-store.test.ts)
- [通用 Agent + 真实 PostgreSQL 长结果与证据测试](../../../packages/agent-host/test/database-agent-postgres.integration.test.ts)
