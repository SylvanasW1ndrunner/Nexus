# core-rag 混合检索模块

## 模块目标

本模块负责 Schema RAG 的默认检索路径。当前阶段不引入 SQLite FTS5、sqlite-vec 或 reranker native 依赖，而是在 `core-rag` 内先建立可替换的混合检索边界，保证 Agent 和后续工具可以稳定使用同一个服务入口。

核心目标：

- 显式引用优先：用户写 `@schema.table` 或 `@schema.table.column` 时，结果必须优先命中对应对象。
- 多通道融合：默认融合 explicit、keyword、glossary 三路信号，并保留 `scoreDetails` 方便后续评估和调参。
- 图扩展：直接命中后按关系图补充同表列、相关表和远端上下文，支持 `includeRelations` 与 `expandHops`。
- 可替换边界：未来 SQLite FTS5、sqlite-vec、embedding provider、reranker 只能替换 retriever/storage adapter，不能污染 Agent 工具和 shared IPC 合同。

## 代码入口

- `packages/core-rag/src/hybrid-schema-retriever.ts`
  - `searchSchemaRagIndex(index, request)` 是当前默认混合检索实现。
  - 内部通道包括 `explicit`、`keyword`、`glossary`，使用 RRF 风格融合分数。
  - 图扩展优先返回同表上下文，再返回相关表，最后返回远端列。
- `packages/core-rag/src/schema-rag-engine.ts`
  - `SchemaRagEngine.search()` 保持原公共入口，内部委托给默认 retriever。
  - `buildContext()`、`describeTable()`、`getRelations()` 不暴露第三方检索实现细节。
- `packages/core-rag/src/types.ts`
  - 新增 `SchemaRagRetriever`、`SchemaRagRetrievalChannel`、`SchemaRagScoreDetail`。
  - `SchemaRagSearchRequest` 新增 `expandHops`、`tokenBudget` 合同字段；本轮实现 `expandHops`，`tokenBudget` 作为后续 token-aware context builder 入口。

## 依赖与开源方案判断

本轮没有新增依赖。

评估结论：

- `better-sqlite3` 能提供成熟 SQLite 访问能力，但属于 native module，会引入 Electron ABI、Windows 构建链、离线安装和打包验证成本。
- `sqlite-vec` 是后续向量索引方向，但当前仍应通过 adapter 接入，不能直接进入公共类型或 Agent 工具返回结构。
- 当前产品阶段需要先把检索语义、结果结构和测试矩阵稳定下来，因此本轮选择纯 TypeScript 默认 retriever。

后续引入 SQLite/向量依赖的条件：

- 完成单独 dependency spike，记录许可证、包体积、native build、Electron 打包、Windows/Linux/macOS 行为。
- 提供 `SchemaRagRetriever` 或 storage adapter 替换实现，不改变 `SchemaRagEngine.search()` 调用方。
- 默认无 embedding provider 时必须回退到 explicit + keyword + glossary + graph。

## 行为约束

- `SchemaRagDocument.id` 继续使用 `table:schema.table`、`column:schema.table.column`，不得替换为 SQLite rowid 或 vector rowid。
- `scoreDetails` 可用于调试和评估，但调用方不能依赖精确分数，测试只断言排序、命中 ID 和关键 reason。
- `includeRelations: false` 时只返回直接命中，不做图扩展。
- quoted identifier 中允许包含点号，例如 `@"sales.data"."order.items".sku`。
- RAG index 仍按 connection 隔离，glossary 和图扩展不能跨连接泄漏。

## 测试覆盖

- `packages/core-rag/test/hybrid-schema-retriever.test.ts`
  - 显式列引用压过宽泛关键词。
  - keyword + glossary 融合召回业务指标。
  - 图扩展补充 JOIN 上下文。
  - `includeRelations=false` 关闭图扩展。
  - `expandHops=2` 支持二跳相关表。
  - 多连接隔离。
- `packages/core-rag/test/schema-rag-engine.test.ts`
  - 旧搜索、上下文、表描述、关系接口回归。
  - quoted identifier 点号解析。
- `packages/core-rag/test/progressive-schema-rag-indexer.test.ts`
  - snapshot restore 后 hybrid 检索 ID、reason、scoreDetails 保持一致。

## 已知限制

- 当前 keyword 通道仍是内存 token/text 扫描，不是 SQLite FTS5。
- 当前没有 embedding provider、vector storage、reranker。
- `tokenBudget` 合同已预留，但 `buildContext()` 仍按字符数裁剪。
- `ProgressiveSchemaRagIndexer` 仍是状态合同和 snapshot 恢复能力，尚未做到真实分阶段 catalog 抽取。
