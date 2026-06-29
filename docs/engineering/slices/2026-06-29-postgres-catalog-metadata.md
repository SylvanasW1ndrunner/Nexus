# 2026-06-29 PostgreSQL catalog 元数据增强切片

## 背景

当前开发路径是先完成后端核心能力，最后统一重建前端 UI。Schema RAG 和 Agent 后续要可靠理解真实生产库，必须从数据库 catalog 中读取更多结构信息，而不能只依赖表名、字段名和注释。

本切片聚焦 `core-db -> core-rag -> core-agent tools` 的只读 metadata 链路。

## 范围

已实现：

- `PostgresDriver.describeTable()` 读取 row estimate、view definition、indexes、constraints。
- `ColumnSummary` 增加字段级索引和单字段唯一提示。
- `TableDetail` 增加表级 catalog metadata。
- `core-rag` 表文档和字段文档消费这些 metadata。
- Agent RAG 工具 `describe_table` 能输出索引、约束和估算行数。
- 真实 PostgreSQL 测试覆盖索引、约束、视图和复合唯一边界。

未包含：

- 不新增正式前端 UI。
- 不新增向量库、reranker 或通用 RAG 框架。
- 不做 SQL AST、血缘、自动改写或权限推断。
- 不改变写 SQL 的确认和事务门禁。

## 验收标准

- 类型合同兼容旧调用方，可选字段不破坏现有测试。
- PostgreSQL 真实 catalog 能返回索引、约束、视图定义和估算行数。
- 复合唯一索引不会把单个字段误标为唯一。
- RAG 检索和 Agent 工具上下文能看到新增 metadata。
- 新增依赖为 0。
- 中文工程文档记录接口、测试、安全和开源评估。

## 测试入口

默认测试：

```bash
pnpm test
```

真实 PostgreSQL：

```bash
pnpm test:postgres
```

局部验证：

```bash
node node_modules/vitest/vitest.mjs run packages/core-rag/test/schema-catalog-metadata.test.ts
node node_modules/vitest/vitest.mjs run packages/core-agent/test/schema-rag-tools.test.ts
```

## 风险

- PostgreSQL `reltuples` 是估算值，不是精确行数，只能用于规模判断和 RAG 提示。
- 视图定义和 check 约束可能包含业务逻辑或常量，上层注入 LLM 时必须截断并避免泄露 secret。
- 不同数据库对 catalog 的表达差异很大，后续 MySQL、ClickHouse、SQL Server 需要各自 driver adapter 实现，不应强行复用 PostgreSQL 查询。
