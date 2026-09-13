# Database Capability：Schema 知识

本文描述内部 Capability 实现与测试，不代表终端已有数据库连接、索引或检索入口。

## 功能

Schema 知识把已连接数据库的资源发现结果构造成可检索的目录：Schema、表、视图、列、关系与业务知识可通过 `resource_list`、`resource_get`、`resource_search` 等工具按需发现。模型收到的是名称、关系、字段和业务语义的投影，不是 RAG 索引的内部 hash、slot、文档 ID 或连接器实现细节。

索引状态由 `schemaStatus()` 表示为 `not_connected`、`not_indexed` 或 `ready`，并包含表、列、关系、文档数量及截断信息。当前 Schema 提取与 PostgreSQL 连接器结合；其他数据库不在当前可用性承诺内。

## 设计

Schema RAG 按连接保存索引和目录，工具 generation 捕获该连接的 `SchemaRagReadView`。工具不能绕过 binding 查找“最新”索引，因此同一 Turn 的读取始终面对一个精确的 Schema 视图。

首次索引、周期 freshness 与强制 freshness 均先发现资源，再比较 source revision。索引变化后，必须完成对应 Capability generation publication，调用才算完成；后台触发可以异步，但不会把“索引已更新、工具仍是旧 generation”当成成功。freshness 的 single-flight 和去抖按 `{profileId, connectionId}` 绑定：连接 A 的在途或近期检查不会满足、抑制或更新时间到连接 B。

Schema 读取与更新遵守 active binding 读写栅栏。索引/刷新在读栅栏内检查 binding；连接切换等待已开始的刷新完成，随后旧 binding 不会为新连接发布目录。若 binding 已退休，调用返回可重试的 `CONNECTION_FAILED`，不会把旧连接的资源混进新连接。

## 效果与边界

- Database Capability 未激活时，其工具不会进入首轮模型上下文；激活后工具集在下一轮统一加载，但完整 Schema 仍只通过有界资源检索按需返回，不会整体塞进模型上下文。
- 检索输出使用面向模型的资源投影；内部资源主键、RAG revision/hash 与索引实现不属于模型合同。
- 目录的“ready”只说明该连接已有可用索引；它不是数据库服务器的一致性快照，也不代替再次执行 SQL 时的数据库事实。
- 索引可能因 `maxTables` 截断，状态会明确反映；调用方不能把它解释为全库枚举保证。
- Schema 刷新失败不会改变已经完成的 SQL 事实；它只意味着知识目录可能落后，后续可刷新或检索最新结构。

## 场景

1. 连接后调用 `indexSchema()`，模块发现当前资源、建立 RAG 目录并发布包含 Schema 工具的新 generation。
2. 模型先使用 `resource_search` 找到候选，再以 `resource_get` 读取某张表及其关系；结果只包含业务可读信息。
3. 找不到资源引用时，工具可请求强制 freshness，并在同一 binding 上重试一次解析。
4. DDL 已提交但目录刷新失败时，SQL 工具如实返回“SQL 已成功、Schema 可能尚未反映变更”，不替模型决定是否重试 SQL。
5. 连接切换期间，旧 generation 的 Schema 操作不会获得新连接的目录；它应重试并让下一 generation 处理。

## 代码与测试

- [Schema 索引、freshness 与 publication 边界](../../../packages/database-capability/src/database-capability-module.ts)
- [模型可见的 Schema 工具与投影](../../../packages/database-capability/src/ai-sql-tools.ts)
- [Schema RAG 引擎](../../../packages/core-rag/src/schema-rag-engine.ts)
- [知识目录构造](../../../packages/core-rag/src/knowledge-catalog.ts)
- [连接切换、freshness single-flight 与 publication 测试](../../../packages/database-capability/test/database-capability-module.test.ts)
- [DDL 刷新失败投影测试](../../../packages/database-capability/test/ai-sql-invocation-runtime.test.ts)
