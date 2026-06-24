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

## 开源借鉴与复用边界

Schema RAG 开发默认先调研成熟开源实现和设计，再决定复用、adapter、fork、借鉴设计或自研。重点包括：

- metadata parser、SQL parser、schema document 建模。
- SQLite FTS、sqlite-vec、pgvector、嵌入式向量索引或外部向量库。
- hybrid retrieval、RRF、reranker、embedding provider、context builder。
- RAG eval、LLM judge、检索数据集和指标计算。
- 图关系扩展、业务术语抽取、同义词/别名维护。

第三方 RAG 框架或向量库不能直接决定 DBAgent 的稳定合同。`core-rag` 对外仍暴露连接级 schema 文档、检索结果、关系上下文和 token-budgeted context；外部库只能通过 adapter 接入 extractor、indexer、retriever、provider 或 storage 层。

选择暂不引入开源组件时，release note 必须写明原因，例如当前切片只需要结构化 metadata 的轻量能力、通用文档 RAG 不匹配、native module 打包风险、默认联网下载模型、离线不可用、许可证不清晰或安全边界不满足。

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

## Agent 工具调用接口

本轮新增 `SchemaRagEngine` 的后端工具级接口，供 Agent、命令面板、后续 IPC 和测试入口复用：

- `hasIndex(connectionId)`：判断连接是否已有可用索引。
- `listTables({ connectionId, schema, limit })`：列出已索引表，返回稳定表 ID、schema、表名、类型和字段数量。
- `describeTable({ connectionId, table, schema, maxChars })`：返回单表、字段、直接关联表和可注入模型的结构化文本。
- `getRelations({ connectionId, table, schema })`：返回单表的一跳关系文档和相关表。

表引用支持 `schema.table` 或 `table + schema` 两种形式；裸表名在多个 schema 中命中时会抛出歧义错误，要求上层让 Agent 或用户补充 schema，而不是猜测。该行为用于避免 Agent 在生产库多 schema 场景下查询错表。

本切片未引入新的第三方 RAG 框架或向量库。原因是当前能力是结构化 metadata 的轻量工具接口，直接复用现有内存索引即可；后续接入 sqlite-vec、FTS5、RRF、reranker 或 LlamaIndex/Haystack 等方案时，需要按 `docs/engineering/open-source-first.md` 重新记录许可证、Electron 打包、离线、模型下载和安全边界。
## 连接级持久化快照与渐进索引状态

本轮新增 `SchemaRagSnapshotStore` 和 `ProgressiveSchemaRagIndexer`，目标是先解决 Schema RAG 在应用重启后的可恢复性，以及后续大 schema 渐进索引所需的状态合同。

- `SchemaRagSnapshotStore` 位于 `packages/core-rag/src/schema-rag-snapshot-store.ts`，只负责连接级快照文件读写。快照采用 JSON v1 格式，保存 `connectionId`、`indexedAt`、documents、glossary 和 graph edge records；读取时重建 `Map<string, Set<string>>` 运行态 graph。
- 快照写入使用临时文件加 rename 的原子替换策略，避免半写入文件覆盖上一份完整快照。损坏、缺失或旧版本快照会返回 `undefined`，不阻断数据库连接、SQL 执行或后续重新索引。
- `SchemaRagEngine.loadIndex()` 用于应用重启后 hydrate 内存索引；`getIndexStatus()` 用于让 Agent/UI 判断当前连接是 `idle` 还是 `ready`，不改变现有同步 `search()`、`buildContext()`、`describeTable()` 合同。
- `ProgressiveSchemaRagIndexer` 位于 `packages/core-rag/src/progressive-schema-rag-indexer.ts`，当前先提供 `skeleton -> hot_tables -> long_tail -> ready` 的状态模型。第一版仍一次性构建完整内存索引，后续可以把每个阶段替换为真实分批 catalog 抽取和 on-demand 单表索引。

本能力不作为官方插件候选。它属于 `core-rag` 与连接生命周期绑定的基础设施；适合插件化的是外围能力，例如 embedding provider、reranker、RAG eval、ER 图导出、业务术语维护工具等。

开源借鉴记录：

- LlamaIndex.TS 的 StorageContext/持久化层说明了索引、文档存储和向量存储应当隔离在 storage adapter 后面，本轮采用同样的分层思想，但不引入框架依赖。
- SQLite FTS5 是后续本地全文检索的优先候选，适合替换当前轻量 token 检索；本轮暂不引入，是因为还没有 SQLite 存储 adapter 和 Electron native 打包评估。
- sqlite-vec 是后续本地向量检索候选，Node.js 可接入，但其文档仍提示 pre-v1 可能有破坏性变化；因此当前只保留 adapter 边界，不进入发布依赖。

新增测试：

- `schema-rag-snapshot-store.test.ts`：真实临时目录读写，覆盖保存、读取、恢复后检索、损坏快照、旧版本快照、按连接删除。
- `progressive-schema-rag-indexer.test.ts`：覆盖渐进阶段状态、快照落盘、模拟进程重启后的恢复和空连接 idle 状态。
