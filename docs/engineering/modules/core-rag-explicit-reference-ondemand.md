# core-rag 显式引用与按需索引

## 目标

本模块补充 Schema RAG 在真实 Agent 使用中的两个关键能力：

- 用户或 Agent 在问题中显式写出 `@schema.table` 或 `@schema.table.column` 时，检索必须优先命中该对象。
- 当显式引用的表还没有完整索引时，可以通过 catalog reader 按需 `describeTable()`，然后增量 upsert 到当前连接的 RAG 索引。

这对应产品文档里的“显式引用”和“on-demand 索引”要求，解决大库渐进索引期间冷门表暂未完整进入 RAG 的问题。

## 接口

新增文件：

- `packages/core-rag/src/explicit-references.ts`
  - `extractExplicitSchemaReferences(query)`
  - `parseExplicitSchemaReference(raw)`

扩展 `SchemaRagEngine`：

- `search()` 支持 `explicitTables` 和 `explicitColumns` 可选输入。
- 查询文本中的 `@...` 引用会被自动解析并加权。
- `upsertTables()` 用于把按需读取到的 `TableDetail[]` 合并进已有索引。
- `hasTable()` 用于判断当前连接下某张表是否已经可描述。

扩展 `ProgressiveSchemaRagIndexer`：

- `upsertTables()` 调用 engine 增量合并，并在配置了 snapshot store 时保存快照。

扩展 `schema-catalog-indexer`：

- `ensureSchemaCatalogTablesIndexed()` 负责把显式引用解析为 catalog 表，调用 reader 读取详情，并 upsert 到索引。

## 引用解析规则

支持：

- `@orders`
- `@public.orders`
- `@public.orders.total_amount`
- `@"Sales Data"."Order Items".sku`

二段式 `@a.b` 固定解释为 `schema.table`。原因是 `table.column` 和 `schema.table` 在没有 catalog 上下文时不可区分；为了避免误索引，列引用必须写三段式 `@schema.table.column`。

裸表名如 `@orders` 可能在多个 schema 中命中。`ensureSchemaCatalogTablesIndexed()` 会返回 `AMBIGUOUS_TABLE` warning，并拒绝猜测具体表。

## 安全边界

该能力只读取 schema catalog，不执行用户 SQL，不读取表数据，不接触连接密码或 API key。

按需索引仍然会把视图定义、索引定义和约束定义写入 RAG 文档，因此 LLM 注入时继续遵守已有截断策略。写 SQL、DDL 和数据修改仍由 `core-db` 的 SQL 安全门禁和 Agent 权限系统控制。

## 插件化边界

显式引用解析和 RAG upsert 属于核心能力，不做插件。

适合插件化的是 catalog reader：

- PostgreSQL catalog reader 官方插件。
- MySQL/ClickHouse/SQL Server catalog reader 官方插件。
- 企业元数据平台或 MCP catalog reader 插件。

这些插件只需要实现 `SchemaCatalogReader` 合同，就能复用 `ensureSchemaCatalogTablesIndexed()`。

## 开源复用评估

本切片不新增依赖。

原因：

- 显式引用解析是小型、确定性语法，不需要引入 SQL parser 或通用 NLP。
- 按需索引只依赖现有 `SchemaCatalogReader` 和 `ProgressiveSchemaRagIndexer`。
- 引入 LlamaIndex、Haystack、LangChain、sqlite-vec 或 parser 不会改善本切片的核心问题，反而增加打包和离线风险。

后续如果做自然语言实体链接、跨库 disambiguation 或 SQL AST 级列引用识别，再重新评估成熟开源组件。

## 测试

默认测试：

- `schema-rag-engine.test.ts`
  - 显式表引用优先命中。
  - 显式列引用优先命中。
  - `upsertTables()` 把 skeleton 表替换为完整表详情。
- `schema-catalog-indexer.test.ts`
  - fake catalog reader 下按需索引冷门表。
  - 裸表名歧义和缺失表不会误改索引。
- `progressive-schema-rag-indexer.test.ts`
  - upsert 后 snapshot 保存，重启恢复后仍可检索新表。

真实 PostgreSQL：

- `packages/core-tools/test/agent-rag-business-scenario.test.ts`
  - 先只索引 analytics schema 的部分表。
  - 再通过 `@public.refunds` 触发真实 PostgreSQL catalog describe。
  - 验证 upsert 后 RAG 能优先搜到 `public.refunds`。
