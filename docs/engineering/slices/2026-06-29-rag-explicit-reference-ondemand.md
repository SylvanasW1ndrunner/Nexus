# 2026-06-29 RAG 显式引用与按需索引切片

## 产品场景

数据工程师面对大生产库时，RAG 可能先完成热表或部分 schema 索引。用户仍会直接问：

> 帮我看一下 `@public.refunds` 这个退款表怎么和订单表关联。

在这种情况下，系统不能因为冷门表暂未完整索引就回答“不存在”，也不能猜测同名表。正确行为是：

1. 解析显式引用。
2. 在 catalog 中精确定位表。
3. 对未索引表按需读取详情。
4. 增量写入当前连接的 RAG 索引和快照。
5. 再让 Agent 正常检索/描述该表。

## 实现范围

已完成：

- 显式引用解析：`@table`、`@schema.table`、`@schema.table.column`。
- RAG 搜索显式引用加权。
- `SchemaRagEngine.upsertTables()`。
- `ProgressiveSchemaRagIndexer.upsertTables()`。
- `ensureSchemaCatalogTablesIndexed()`。
- 默认测试、恢复测试和真实 PostgreSQL 业务 fixture 测试。

未包含：

- 不做向量库或 reranker。
- 不做 SQL AST 解析。
- 不做 UI 状态提示。
- 不做跨连接 RAG。
- 不自动采样表数据。

## 设计决策

二段式引用 `@a.b` 固定解释为 `schema.table`，列引用必须写 `@schema.table.column`。这是为了避免在未加载 catalog 前把 `table.column` 错当成 `schema.table` 或反过来。

裸表名歧义时不猜测，返回 `AMBIGUOUS_TABLE` warning。Agent 或 UI 后续应提示用户补 schema。

## 验收

已验证：

- 默认 core-rag 测试通过。
- core-tools 业务 RAG 测试通过。
- 真实 PostgreSQL gate 通过，包含按需索引 `public.refunds`。
- upsert 后 snapshot 可恢复。

## 后续

- 把 `ensureSchemaCatalogTablesIndexed()` 接入 Agent 工具执行前逻辑：当 `search_schema` 检测到显式引用且当前索引缺表时自动调用。
- 为搜索结果增加 `warnings` / `resolvedReferences`，方便最终 UI 展示“已按需索引 X 表”。
- 评估 SQLite FTS5 持久化索引，替换当前内存 token 检索。
