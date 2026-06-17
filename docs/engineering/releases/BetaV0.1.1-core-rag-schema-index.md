# BetaV0.1.1 Core RAG Schema Index

## 背景

Agent 后续不能把全量 schema 粗暴塞进 prompt，需要先有结构化 Schema RAG 能力。本次实现 Stage 1：不接 embedding，不引入 sqlite-vec，先保证 schema 文档化、词法检索、关系扩展和上下文预算可靠。

## 本次实现

新增 `packages/core-rag`：

- `buildSchemaDocuments()`
  - 将 `TableDetail[]` 转换为 table / column 文档。
  - 生成稳定 document id。
  - 保留字段类型、主键、外键、注释等 metadata。
- `SchemaRagEngine`
  - 按 connectionId 建立独立内存索引。
  - 支持 search。
  - 支持 relation expansion。
  - 支持 buildContext。
  - 支持 clear(connectionId)。
- tokenizer
  - 支持英文标识符。
  - 支持 snake_case 拆分。
  - 支持中文连续词和 bigram。

## 用户级测试场景

已覆盖：

- 数据工程师输入 `orders`，能优先召回 `public.orders` 表。
- 表命中后，能带出关键外键字段，例如 `orders.user_id`。
- 用户输入中文“订单金额”，能通过字段注释召回 `orders.total_amount`。
- 用户输入“用户订单”，能同时召回用户表和订单表上下文。
- 构建 prompt context 时遵守字符预算，并明确标记是否截断。
- 连接断开后清理索引，再查询会明确报错，不会混用旧 schema。

## 当前边界

已实现：

- Stage 1 Skeleton RAG。
- 表 / 字段文档。
- 关系图扩展。
- 中英文词法检索。
- prompt context 构建。

暂未实现：

- SQLite 持久化。
- sqlite-vec / embedding。
- 热表分阶段索引。
- 长尾后台索引。
- RRF / rerank。
- glossary。

## 后续衔接

下一步应将 `core-rag` 接入 Agent 内置工具：

- `search_schema`
- `describe_table`
- `get_relations`

然后再接入真实 PostgreSQL schema fixture，验证 `core-db -> core-rag -> core-agent` 的完整后端链路。
