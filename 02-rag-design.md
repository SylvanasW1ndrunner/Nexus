# 02 - RAG 设计（Schema RAG Engine）

> 文档版本：v0.1
> 关联：[00-overview.md](./00-overview.md)

---

## 1. RAG 在本项目的定位

### 1.1 不是通用 RAG

**关键认知**：本项目的 RAG 不是"文档问答"型 RAG，而是**结构化 Schema 检索系统**。

| 通用 RAG | DBAgent Schema RAG |
|---|---|
| 输入：非结构化文档 | 输入：结构化 schema 元数据 |
| 切分：按句/段 | 切分：按表/列/关系 |
| 检索：纯语义相似 | 检索：语义 + 结构 + 图关系 |
| 输出：相关文档片段 | 输出：精准 schema 子集（含外键） |

### 1.2 RAG 要解决的核心问题

1. **避免全量 schema 喂入 LLM**：一个生产数据库可能有几百到几千张表，全塞 prompt 会爆 context 也烧 token
2. **支持模糊语义检索**：用户说"销量"时能找到 `order_items.qty`、`sales.amount` 等字段
3. **关系完整性**：找到 `users` 表时自动带出关联的 `orders`，否则 SQL 生成会缺 JOIN
4. **业务语义层**：用户/团队可以补充业务术语（"活跃用户 = 30 天内有订单"），让 agent 理解领域

---

## 2. 整体架构

### 2.1 架构图

```
                    ┌──────────────────┐
                    │  用户连接数据库   │
                    └────────┬─────────┘
                             │
                    ┌────────▼─────────┐
                    │ Schema Extractor │ ← 阶段 1：提取
                    │  (PG/MySQL...)   │
                    └────────┬─────────┘
                             │
                ┌────────────┼────────────┐
                ▼            ▼            ▼
        ┌──────────┐ ┌──────────┐ ┌──────────┐
        │ Tables   │ │ Columns  │ │ Relations│
        └─────┬────┘ └─────┬────┘ └─────┬────┘
              │            │            │
              └────────────┼────────────┘
                           │
                  ┌────────▼─────────┐
                  │  Schema Document │ ← 阶段 2：建模
                  │  (统一中间表示)  │
                  └────────┬─────────┘
                           │
                ┌──────────┴──────────┐
                ▼                     ▼
        ┌──────────────┐      ┌──────────────┐
        │  Indexer     │      │  Graph       │
        │  (向量化)    │      │  Builder     │
        └──────┬───────┘      └──────┬───────┘
               │                     │
        ┌──────▼───────┐      ┌──────▼───────┐
        │ sqlite-vec   │      │ SQLite Graph │ ← 阶段 3：存储
        │ (Embeddings) │      │ (Adjacency)  │
        └──────┬───────┘      └──────┬───────┘
               │                     │
               └──────────┬──────────┘
                          │
                 ┌────────▼─────────┐
                 │ Hybrid Retriever │ ← 阶段 4：检索
                 │ (vec + graph +   │
                 │  keyword + rank) │
                 └────────┬─────────┘
                          │
                 ┌────────▼─────────┐
                 │ Context Builder  │ ← 阶段 5：组装
                 │ (注入 prompt)    │
                 └────────┬─────────┘
                          │
                          ▼
                    [Agent 使用]
```

### 2.2 模块职责

| 模块 | 职责 | 文件位置（建议） |
|---|---|---|
| Schema Extractor | 从数据库提取元数据 | `src/main/rag/extractors/` |
| Schema Document | 统一中间表示 | `src/main/rag/types.ts` |
| Indexer | 向量化、写入存储 | `src/main/rag/indexer.ts` |
| Graph Builder | 构建表关系图 | `src/main/rag/graph.ts` |
| Storage | sqlite-vec + sqlite | `src/main/rag/storage/` |
| Retriever | 混合检索 | `src/main/rag/retriever.ts` |
| Context Builder | 组装注入 prompt | `src/main/rag/context.ts` |

---

## 3. 阶段 1：Schema 提取

### 3.1 提取的内容清单

| 类别 | 内容 | PG 来源 | 优先级 |
|---|---|---|---|
| **数据库** | 名称、版本、字符集 | `pg_database` | P0 |
| **Schema** | 名称、Owner | `information_schema.schemata` | P0 |
| **表** | 名称、注释、估算行数 | `pg_class` + `pg_description` | P0 |
| **列** | 名称、类型、可空、默认值、注释 | `information_schema.columns` | P0 |
| **主键** | 字段集合 | `information_schema.table_constraints` | P0 |
| **外键** | 引用关系 | `information_schema.referential_constraints` | P0 |
| **索引** | 字段、唯一性、类型（btree/gin） | `pg_indexes` | P1 |
| **视图** | 定义 SQL | `pg_views` | P1 |
| **序列** | 关联表 | `pg_sequences` | P2 |
| **存储过程/函数** | 签名、返回类型 | `pg_proc` | P2 |
| **触发器** | 事件 | `information_schema.triggers` | P2 |
| **样本数据** | 每表 N 行（用于值类型推断） | `SELECT ... LIMIT N` | P1 |

### 3.2 数据库适配器接口

为模块化、便于扩展到 MySQL/Oracle，定义统一接口：

```typescript
// src/main/rag/extractors/types.ts

export interface IDatabaseExtractor {
  /** 数据库类型标识 */
  readonly dialect: 'postgresql' | 'mysql' | 'oracle' | ...;

  /** 测试连接 */
  testConnection(config: ConnectionConfig): Promise<ConnectionInfo>;

  /** 列出所有 schema */
  listSchemas(): Promise<SchemaInfo[]>;

  /** 列出指定 schema 的所有表 */
  listTables(schema: string): Promise<TableInfo[]>;

  /** 获取表的完整元数据 */
  describeTable(schema: string, table: string): Promise<TableDetail>;

  /** 提取所有外键关系 */
  listForeignKeys(schemas: string[]): Promise<ForeignKeyRelation[]>;

  /** 获取样本数据 */
  sampleRows(schema: string, table: string, limit: number): Promise<Row[]>;

  /** 监听 schema 变更（可选，PG 通过 LISTEN/NOTIFY） */
  watchSchemaChanges?(callback: (change: SchemaChange) => void): () => void;
}
```

### 3.3 PostgreSQL 实现要点

#### 3.3.1 关键 SQL 示例

**列出所有用户表**：
```sql
SELECT
  n.nspname AS schema_name,
  c.relname AS table_name,
  obj_description(c.oid, 'pg_class') AS table_comment,
  c.reltuples::bigint AS row_estimate
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'r'
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
ORDER BY n.nspname, c.relname;
```

**列详情（含注释）**：
```sql
SELECT
  c.column_name,
  c.data_type,
  c.udt_name,
  c.is_nullable,
  c.column_default,
  c.character_maximum_length,
  pgd.description AS column_comment
FROM information_schema.columns c
LEFT JOIN pg_catalog.pg_statio_all_tables st
  ON st.schemaname = c.table_schema AND st.relname = c.table_name
LEFT JOIN pg_catalog.pg_description pgd
  ON pgd.objoid = st.relid AND pgd.objsubid = c.ordinal_position
WHERE c.table_schema = $1 AND c.table_name = $2
ORDER BY c.ordinal_position;
```

**外键关系**：
```sql
SELECT
  tc.table_schema,
  tc.table_name,
  kcu.column_name,
  ccu.table_schema AS foreign_schema,
  ccu.table_name AS foreign_table,
  ccu.column_name AS foreign_column,
  tc.constraint_name
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON tc.constraint_name = kcu.constraint_name
  AND tc.table_schema = kcu.table_schema
JOIN information_schema.constraint_column_usage ccu
  ON ccu.constraint_name = tc.constraint_name
WHERE tc.constraint_type = 'FOREIGN KEY';
```

#### 3.3.2 提取策略

- **批量执行**：用并发 query 提取，但限制并发数（默认 5）防止把数据库打爆
- **超时控制**：单个 SQL 超时 30 秒
- **权限优雅降级**：某些视图无权访问时，记录 warning，不中断流程
- **大库优化**：表数 > 500 时，先只提取表名/注释，列详情按需懒加载

---

## 4. 阶段 2：Schema Document（统一中间表示）

### 4.1 数据模型

```typescript
// src/main/rag/types.ts

export interface SchemaDocument {
  connectionId: string;
  databaseName: string;
  dialect: string;
  extractedAt: Date;

  schemas: SchemaNode[];
  tables: TableNode[];
  columns: ColumnNode[];
  relations: RelationNode[];
  indexes: IndexNode[];
  views: ViewNode[];

  // 业务语义层（用户/团队补充）
  glossary?: GlossaryEntry[];
}

export interface TableNode {
  id: string;                    // {schema}.{table}
  schema: string;
  name: string;
  comment?: string;
  rowEstimate?: number;
  primaryKey: string[];
  tags?: string[];               // 用户打标签：['核心', '高频', '已废弃']
  sampleRows?: Row[];            // 样本数据（去敏后）
}

export interface ColumnNode {
  id: string;                    // {schema}.{table}.{column}
  tableId: string;
  name: string;
  dataType: string;
  nullable: boolean;
  defaultValue?: string;
  comment?: string;
  isPrimaryKey: boolean;
  isForeignKey: boolean;
  isIndexed: boolean;
  // 用户/系统标注
  semanticType?: 'email' | 'phone' | 'id_card' | 'encrypted' | 'json' | ...;
  customRules?: string[];        // 'AES-encrypted', 'use decrypt_phone tool'
}

export interface RelationNode {
  id: string;
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  relationType: 'one-to-one' | 'one-to-many' | 'many-to-many';
  constraintName?: string;
}

export interface GlossaryEntry {
  term: string;                  // "活跃用户"
  definition: string;            // "30 天内有订单的用户"
  relatedTables: string[];       // ['users', 'orders']
  exampleSql?: string;
}
```

### 4.2 加密/特殊字段识别

**自动识别规则**（启发式，可配置）：
- 字段名含 `_encrypted` / `_enc` / `_cipher` → `semanticType: 'encrypted'`
- 字段名 `email` 且类型 VARCHAR → `semanticType: 'email'`
- 字段名 `phone` / `mobile` → `semanticType: 'phone'`
- 注释含 "加密" / "encrypted" / "AES" → `semanticType: 'encrypted'`
- 类型为 `JSON` / `JSONB` → `semanticType: 'json'`

**用户手动标注**：在 Schema 树右键字段 → "标记为加密字段" → 关联解密工具。

---

## 5. 阶段 3：索引与存储

### 5.1 存储选型

**单一选择：sqlite + sqlite-vec**

| 候选 | 优缺点 | 选用 |
|---|---|---|
| sqlite + sqlite-vec | 嵌入式、单文件、无依赖 | ✅ |
| LanceDB | 高性能但增加打包复杂度 | ❌ |
| Chroma | 需要单独进程 | ❌ |
| 内存 + faiss-node | 重启需重建 | ❌ |

每个数据库连接一个 SQLite 文件，路径：`{appData}/rag/{connectionId}.db`

### 5.2 数据库 Schema

```sql
-- schemas / tables / columns 等元数据
CREATE TABLE meta_tables (
  id TEXT PRIMARY KEY,
  schema TEXT NOT NULL,
  name TEXT NOT NULL,
  comment TEXT,
  row_estimate INTEGER,
  primary_key_json TEXT,
  tags_json TEXT,
  updated_at INTEGER
);

CREATE TABLE meta_columns (
  id TEXT PRIMARY KEY,
  table_id TEXT NOT NULL,
  name TEXT NOT NULL,
  data_type TEXT,
  nullable INTEGER,
  default_value TEXT,
  comment TEXT,
  is_pk INTEGER,
  is_fk INTEGER,
  is_indexed INTEGER,
  semantic_type TEXT,
  custom_rules_json TEXT,
  updated_at INTEGER,
  FOREIGN KEY (table_id) REFERENCES meta_tables(id)
);

CREATE TABLE meta_relations (
  id TEXT PRIMARY KEY,
  from_table TEXT NOT NULL,
  from_column TEXT NOT NULL,
  to_table TEXT NOT NULL,
  to_column TEXT NOT NULL,
  relation_type TEXT
);

CREATE TABLE meta_glossary (
  id TEXT PRIMARY KEY,
  term TEXT NOT NULL,
  definition TEXT,
  related_tables_json TEXT,
  example_sql TEXT
);

-- 向量索引（sqlite-vec）
CREATE VIRTUAL TABLE vec_tables USING vec0(
  embedding float[1024]   -- BGE-M3 维度
);

CREATE VIRTUAL TABLE vec_columns USING vec0(
  embedding float[1024]
);

CREATE VIRTUAL TABLE vec_glossary USING vec0(
  embedding float[1024]
);

-- 关联向量 ID 与元数据 ID
CREATE TABLE vec_id_map (
  vec_table TEXT,         -- 'tables' / 'columns' / 'glossary'
  vec_rowid INTEGER,
  meta_id TEXT,
  PRIMARY KEY (vec_table, vec_rowid)
);

-- 全文搜索（FTS5）作为 keyword 检索
CREATE VIRTUAL TABLE fts_tables USING fts5(
  meta_id UNINDEXED,
  content
);

CREATE VIRTUAL TABLE fts_columns USING fts5(
  meta_id UNINDEXED,
  content
);
```

### 5.3 向量化文本构造

每个对象用一段精心构造的文本进行 embedding，比直接用名字效果好得多。

#### 表的向量化文本：
```
表名: users
所属 schema: public
注释: 用户表，存储所有注册用户的基础信息
主要字段: id, email, phone_enc, nickname, created_at
关联表: orders (一对多), profiles (一对一)
标签: 核心表, 高频访问
```

#### 列的向量化文本：
```
字段: users.email
类型: VARCHAR(255)
注释: 用户邮箱，唯一索引
所在表: users (用户表)
特性: 唯一, 非空, 索引字段
语义: email
```

#### 业务术语的向量化文本：
```
术语: 活跃用户
定义: 30 天内有过订单的用户
相关表: users, orders
示例 SQL: SELECT u.* FROM users u JOIN orders o ON ...
```

### 5.4 Embedding 服务接口

```typescript
export interface IEmbeddingProvider {
  readonly name: string;
  readonly dimension: number;
  readonly maxTokens: number;

  embed(texts: string[]): Promise<number[][]>;
  embedBatch(texts: string[], batchSize?: number): Promise<number[][]>;
}
```

**默认实现**：
- **本地**：BGE-M3 via [@huggingface/transformers](https://www.npmjs.com/package/@huggingface/transformers) (TS 原生)
- **云端**：OpenAI 兼容接口（`text-embedding-3-small`、智谱 `embedding-3` 等）

### 5.5 索引构建流程

```typescript
async function buildIndex(connectionId: string) {
  // 1. 提取
  const doc = await extractor.extractAll();

  // 2. 写元数据
  await db.transaction(async (tx) => {
    await tx.bulkInsert('meta_tables', doc.tables);
    await tx.bulkInsert('meta_columns', doc.columns);
    await tx.bulkInsert('meta_relations', doc.relations);
  });

  // 3. 构造文本 + 批量 embedding
  const tableTexts = doc.tables.map(buildTableText);
  const tableVectors = await embedder.embedBatch(tableTexts, 32);

  const columnTexts = doc.columns.map(buildColumnText);
  const columnVectors = await embedder.embedBatch(columnTexts, 32);

  // 4. 写向量索引
  await writeVectors('vec_tables', doc.tables, tableVectors);
  await writeVectors('vec_columns', doc.columns, columnVectors);

  // 5. 写 FTS 索引
  await writeFts('fts_tables', doc.tables, tableTexts);
  await writeFts('fts_columns', doc.columns, columnTexts);

  // 6. 通知 UI 完成
  emit('rag:indexed', { connectionId, stats });
}
```

### 5.6 增量更新

**触发条件**：
- 用户手动"重新索引"
- 检测到 schema 版本变更（PG 通过 `pg_stat_user_tables` 的 `last_analyze` / DDL 事件）
- 用户编辑了表注释 / 添加了 glossary

**增量策略**：
1. 比较新旧 schema document，得出 `added / modified / removed`
2. 对 added/modified 的对象重新 embedding 并 upsert
3. 删除 removed 对象的索引
4. **不全量重建**

---

## 6. 阶段 4：混合检索（Hybrid Retriever）

### 6.1 为什么不能纯向量检索

纯向量检索的问题：
- "查询用户的订单" → 命中 `users` 和 `orders`，但漏掉了 `order_items`（agent 不知道要 JOIN）
- "上周活跃用户" → 向量可能命中"用户"相关字段，但漏掉"活跃"在 glossary 里的定义
- 用户精确说 "@orders 表" → 应该精准命中，而不是模糊匹配

### 6.2 混合检索流程

```
                 ┌─ 用户查询 ─┐
                 │ "上周GMV"  │
                 └─────┬──────┘
                       │
        ┌──────────────┼──────────────┬───────────────┐
        ▼              ▼              ▼               ▼
   ┌─────────┐   ┌─────────┐    ┌─────────┐    ┌──────────┐
   │ 向量    │   │ 关键词  │    │ Glossary│    │ 显式引用 │
   │ 检索    │   │ FTS5    │    │ 命中    │    │ @orders  │
   └────┬────┘   └────┬────┘    └────┬────┘    └─────┬────┘
        │             │              │               │
        └─────────────┴──────┬───────┴───────────────┘
                             │
                    ┌────────▼────────┐
                    │  RRF 融合排序   │   ← Reciprocal Rank Fusion
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │  图扩展         │   ← 沿外键扩展 1-2 跳
                    │  (Graph Expand) │
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │  Reranker       │   ← (可选) 精排
                    │  (cross-encoder)│
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │  Token 预算裁剪 │
                    └────────┬────────┘
                             │
                             ▼
                    [Top-K Schema 子集]
```

### 6.3 检索接口

```typescript
export interface IRetriever {
  retrieve(query: RetrieveQuery): Promise<RetrieveResult>;
}

export interface RetrieveQuery {
  text: string;
  explicitTables?: string[];      // @users 这类显式引用
  explicitColumns?: string[];
  topK?: number;                  // 默认 20
  expandHops?: number;            // 图扩展跳数，默认 1
  tokenBudget?: number;           // 最大 token 数
}

export interface RetrieveResult {
  tables: TableNode[];
  columns: ColumnNode[];
  relations: RelationNode[];
  glossaryHits: GlossaryEntry[];
  scoreDetails: ScoreDetail[];    // 各路检索得分（debug 用）
}
```

### 6.4 关键算法

#### 6.4.1 RRF 融合
```
score(d) = Σ 1 / (k + rank_i(d))   where k=60
```

#### 6.4.2 图扩展
拿到 top-N 表后，沿外键扩展：
- 1 跳：被引用 + 引用的表
- 2 跳：再扩展一层（可选，量大）
- 限制：扩展后总表数 ≤ tokenBudget 允许的上限

#### 6.4.3 Token 预算裁剪
- 估算每个表/列的 prompt token 占用
- 超预算时按 score 降序保留
- **核心表（被多个表引用的）优先保留**

### 6.5 检索质量保障

- **检索日志**：记录每次检索的 query、命中、耗时，用户可在 Plan 面板查看
- **用户反馈机制**：在结果不满意时，用户可标记"应该查询 XX 表"，作为后续改进数据
- **冷启动**：刚连接数据库时，无历史用户反馈，依赖纯模型能力 + 默认权重

---

## 7. 阶段 5：上下文组装（Context Builder）

### 7.1 组装策略

将检索结果转成结构化的、token 高效的上下文。**不是简单拼字符串，而是分层结构化**：

```
You have access to a PostgreSQL database. Here are the relevant schemas:

## Tables

### users (用户表)
- 行数估算: 123,456
- 主键: id

| Column | Type | Nullable | Comment |
|---|---|---|---|
| id | BIGINT | NO | 用户ID |
| email | VARCHAR(255) | NO | 邮箱（唯一） |
| phone_enc | BYTEA | YES | 加密手机号 ⚠ 需用 decrypt_phone tool |
| ...

### orders (订单表)
...

## Relationships
- orders.user_id → users.id (many-to-one)
- order_items.order_id → orders.id (many-to-one)

## Business Glossary
- "活跃用户": 30 天内有订单的用户

## Notes
- phone_enc 字段为 AES 加密，查询时需调用 decrypt_phone tool 解密
- orders 表数据量大（千万级），建议添加时间范围过滤
```

### 7.2 不同任务的不同模板

| 任务类型 | 模板侧重 |
|---|---|
| 生成 SELECT | 表 + 列 + 关系 + glossary |
| 生成 INSERT/UPDATE | 表 + 列（含 not null/default）+ 约束 |
| EXPLAIN 解读 | 索引信息 + 行数估算 |
| Schema 问答 | 完整描述 + DDL |

### 7.3 Token 优化

- 列默认只显示前 20 个，超出折叠为 "...(还有 N 列)"
- 注释超过 50 字符截断
- 样本数据默认不带，需要时单独 retrieve

---

## 8. RAG 与 Agent 的协作接口

```typescript
// Agent 调用 RAG 的统一接口
export interface IRagService {
  /** 主动检索 */
  search(connectionId: string, query: RetrieveQuery): Promise<RetrieveResult>;

  /** 获取指定对象的完整描述 */
  describe(connectionId: string, objectId: string): Promise<string>;

  /** 列出所有 schema/table（轻量） */
  listObjects(connectionId: string, type: 'schema' | 'table'): Promise<ObjectSummary[]>;

  /** 用户/Agent 添加业务术语 */
  addGlossary(connectionId: string, entry: GlossaryEntry): Promise<void>;

  /** 索引状态 */
  getIndexStatus(connectionId: string): Promise<IndexStatus>;
}
```

**Agent 默认会有的工具（基于 RAG）**：
- `search_schema(query)` — 模糊检索
- `describe_table(table_name)` — 获取表详情
- `list_tables(schema?)` — 列出表
- `get_relations(table_name)` — 获取关联

---

## 9. 性能与成本

### 9.1 性能目标

| 操作 | 目标 |
|---|---|
| 初次索引（100 表） | < 30 秒 |
| 初次索引（1000 表） | < 5 分钟 |
| 增量更新（10 表） | < 5 秒 |
| 检索（top-20） | < 100ms |

### 9.2 Embedding 成本

- 假设平均每个对象（表/列）文本约 100 tokens
- 1000 表 × 20 列 = 20000 列 + 1000 表 = 21000 对象 ≈ 2.1M tokens
- 用 OpenAI `text-embedding-3-small`（$0.02/1M）：约 ¥0.3
- 用本地 BGE-M3：完全免费，但 CPU 推理较慢，建议有 GPU 时启用

### 9.3 存储成本

- 1024 维 float32 向量 = 4KB
- 21000 向量 ≈ 84MB
- 加上元数据 + FTS，总计约 150MB / 中型库

---

## 10. 安全考虑

- **样本数据脱敏**：默认不抓样本数据，用户主动开启时也对邮箱/手机/身份证等做掩码
- **敏感字段不进 RAG**：用户可标记字段"不索引"，agent 看不到该字段存在
- **本地存储加密**：sqlite 文件可用 SQLCipher 加密（设置中开启）
- **跨连接隔离**：每个连接独立 sqlite 文件，绝不共享

---

## 11. 模块化与扩展

### 11.1 添加新数据库（如 MySQL）

只需实现 `IDatabaseExtractor` 接口：
```typescript
class MySQLExtractor implements IDatabaseExtractor {
  readonly dialect = 'mysql';
  // ... 实现各方法
}

// 注册
ExtractorRegistry.register('mysql', MySQLExtractor);
```

无需改动索引、检索、上下文组装层。

### 11.2 添加新 Embedding Provider

实现 `IEmbeddingProvider` 即可，已支持的会自动出现在配置面板。

### 11.3 添加新检索策略

`IRetriever` 接口可有多个实现：
- `HybridRetriever`（默认）
- `PureVectorRetriever`（轻量）
- `LLMRetriever`（用小模型直接判断相关性，慢但准）

通过设置切换。

---

## 12. 待定与未来

- [ ] **Schema 进化追踪**：记录 schema 历史变更，支持"两个月前的 schema"查询
- [ ] **样本数据语义增强**：用 LLM 总结样本数据特征作为额外 embedding 输入
- [ ] **跨库 RAG**：用户跨多个连接查询时的联邦检索
- [ ] **慢查询自动总结**：从慢查询日志自动学习业务模式
- [ ] **Schema 共享**：团队成员之间共享 RAG 索引（脱敏后）
