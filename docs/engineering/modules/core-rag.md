# core-rag Schema RAG 与 ER 图模块

## 代码入口

- `packages/core-rag/src/schema-documents.ts`：将 `TableDetail[]` 转换为结构化 schema 文档。
- `packages/core-rag/src/schema-rag-engine.ts`：内存索引、关键词检索、关系扩展和上下文构建。
- `packages/core-rag/src/retrieval-evaluation.ts`：针对真实用户问题评估 RAG 检索召回效果。
- `packages/core-rag/src/er-diagram.ts`：基于 schema 元数据生成 Mermaid ER 图文本。
- `packages/core-rag/src/types.ts`：RAG 文档、索引、检索和上下文类型。

## 开发逻辑

`core-rag` 当前负责 schema 元数据的结构化使用，不直接连接数据库，也不依赖 renderer UI。它的输入来自 `core-db` 的 `TableDetail[]`，输出给 Agent、导出、ER 图和后续 UI 使用。

Schema RAG 当前是 Stage 1：以表、字段和外键关系为基础做词法检索与关系扩展。它不是通用文档 RAG，不做任意文本切块；每个文档都有稳定 ID，例如 `table:public.orders`、`column:public.orders.user_id`。连接断开时调用 `clear(connectionId)` 清理索引，避免跨连接混用 schema。

业务术语 glossary 是 Stage 1 的语义补强层。调用方可以在 `index()` 时传入 `SchemaRagGlossaryEntry[]`，把 GMV、客单价、活跃用户等业务词映射到稳定 schema 文档 ID。搜索时如果用户问题命中 term 或 alias，目标文档会获得额外权重，并在 `reasons` 中记录 `glossary:<term>`。引擎会丢弃空 term 和指向不存在文档的词条；glossary 随连接索引存储，连接之间互不污染。

检索质量评估使用 `evaluateSchemaRagRetrieval()`。调用方提供一组真实业务问题和必须召回的 schema 文档 ID，评估器返回每个 case 的召回 ID、缺失必选项、缺失建议项、误召回禁止项、命中率和通过状态。这个评估器不依赖 LLM，也不引入第三方 RAG eval 依赖；它先作为 schema 检索质量基线，后续接入向量、rerank 或 LLM judge 时，需要按开源优先规则评估成熟组件并记录许可证、打包、离线和安全影响。

ER 图生成使用 `generateMermaidErDiagram()`。它从 `TableDetail[]` 中读取：

- 表名和 schema。
- 字段名、数据类型、nullable。
- 主键标记。
- 外键标记。
- 外键关系。

输出为 Mermaid `erDiagram` 文本，同时返回表数量、关系数量、字段截断列表和 warnings。默认每表最多显示 10 个字段，避免大表生成不可读图；超过 30 张表会提示调用方生成关系子图。`selectedTables` 可用于只生成部分表的子图。

Mermaid 对标识符有限制，因此模块会把 `schema.table`、字段名和类型清洗为 Mermaid 可接受的 identifier。该行为只影响图中的显示 ID，不改变原始 schema 元数据。

## 测试覆盖

- `schema-rag-engine.test.ts`：
  - 表和字段转文档。
  - 外键关系互链。
  - 显式表名检索。
  - 中文业务注释检索。
  - 跨表问题召回关系上下文。
  - prompt 上下文预算和截断。
  - 按连接清理索引。
  - GMV 等业务术语 glossary 召回、无效词条过滤和连接隔离。
- `retrieval-evaluation.test.ts`：
  - 真实业务问题的 must/should/must-not schema 召回评估。
  - 必选文档缺失时报告失败和部分召回率。
  - 客单价等业务指标通过 glossary 辅助召回关键表和字段。
- `er-diagram.test.ts`：
  - 从真实风格 `TableDetail[]` 生成 Mermaid。
  - 主键、外键、nullable 标记。
  - 外键关系线。
  - 每表字段数截断和 warning。
  - 选择部分表生成子图。
  - Mermaid identifier 清洗。
  - 大 schema warning。

## 后续扩展

- 加入 SQLite/sqlite-vec 持久化索引。
- 增加 embedding、RRF、rerank，并扩展 glossary 来源。
- 从工作空间数据字典、用户反馈和 Agent 生成文档中增量维护 glossary。
- 对接开源 RAG eval、reranker 或 vector store 前先完成依赖与打包评估。
- ER 图可增加 schema 分组、关系深度筛选和导出元信息。
- 和 Agent 工具打通 `search_schema`、`describe_table`、`get_relations`、`generate_er_diagram`。
