# core-db PostgreSQL catalog 元数据增强

## 目标

本模块补充 `core-db` 的 PostgreSQL 表详情能力，让 `describeTable()` 不只返回字段、主键、外键和注释，还能返回 Agent/RAG/传统 IDE 都需要的 catalog 信息：

- 表或视图的估算行数。
- 视图定义。
- 索引列表，包括索引方法、字段、唯一性、主键、有效状态和 DDL 定义。
- 约束列表，包括主键、外键、唯一、check、exclusion 和原始定义。
- 字段级索引标记和单字段唯一标记。

这些字段都设计为可选字段，保证旧调用方继续兼容。

## 接口边界

共享类型位于 `packages/shared/src/domain.ts`：

- `ColumnSummary.isIndexed?: boolean`
- `ColumnSummary.isUnique?: boolean`
- `TableDetail.rowEstimate?: number`
- `TableDetail.viewDefinition?: string`
- `TableDetail.indexes?: TableIndexSummary[]`
- `TableDetail.constraints?: TableConstraintSummary[]`

实现入口位于 `packages/core-db/src/postgres-driver.ts` 的 `describeTable()`。该方法通过 PostgreSQL catalog 读取 metadata，不引入 ORM，也不让 renderer 直接访问数据库 SDK。

`isUnique` 只表示单字段唯一索引或单字段唯一约束的安全提示。复合唯一索引中的单个字段不会被标记为 `isUnique=true`，避免 Agent 或后续 UI 误判单列天然唯一。

## 安全与性能

视图定义、索引定义和 check 约束可能包含业务逻辑、常量或敏感命名。底层 driver 保留真实定义，供审计、IDE 展示和 RAG 构建使用；上层在注入 LLM 前必须按 token 预算截断，并避免把连接凭据、secret 或执行参数写入文档、日志和测试快照。

本次 catalog 查询仍是单表详情级别，不改变 `listTables()` 的轻量行为。大 schema 场景下继续遵守“先列摘要、按需 describe”的策略，避免连接后一次性扫描过多系统表。

## 开源复用评估

本切片不新增第三方依赖。原因：

- PostgreSQL catalog 能直接提供本轮需要的 row estimate、index、constraint、view definition。
- 引入 ORM 无法覆盖用户任意 SQL、系统 catalog、EXPLAIN、权限和多数据库方言差异，不适合作为用户数据库接入层。
- `libpg_query`、`pgsql-parser` 等 PostgreSQL parser 对后续 SQL AST 能力有价值，但本切片不做 SQL 改写或血缘解析，暂不承担 native/parser 打包风险。

后续如果要做字段血缘、影响行估算、自动 SQL 改写或跨数据库方言分析，应重新按开源优先原则评估 parser，并隔离在 adapter 后面。

## 测试

新增真实 PostgreSQL 测试覆盖：

- 临时表的普通索引、主键索引、单字段唯一约束、复合唯一约束和 check 约束。
- 字段级 `isIndexed` 与单字段 `isUnique`。
- 复合唯一字段不误标为单字段唯一。
- 临时视图的 `viewDefinition` 和字段读取。
- `rowEstimate` 类型稳定。

入口：

```bash
pnpm test:postgres
```

直接运行单测时需要显式设置 `DBAGENT_RUN_POSTGRES_TESTS=1`，并保证测试库已按脚本准备好基础 schema。
