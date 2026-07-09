# core-rag 启动批量恢复

## 目标

本模块为 Schema RAG 增加启动时批量恢复入口。应用启动后可以扫描本地 RAG snapshot 目录，把所有可用连接的 schema index 恢复到 `SchemaRagEngine`，同时报告损坏 snapshot，避免单个坏文件阻塞数据库使用。

## 接口

`ProgressiveSchemaRagIndexer.restoreAll(options?)`

- `connectionIds?: Iterable<string>`：可选过滤器，只恢复指定连接。
- 返回：
  - `restored`: 已恢复的 `SchemaRagIndexStatus[]`。
  - `invalidSnapshots`: 损坏或无法反序列化的 snapshot 路径和原因。
  - `failed`: 扫描或单连接恢复过程中的异常摘要。

## 生命周期

1. `SchemaRagSnapshotStore.list()` 扫描本地 `*.schema-rag.json`。
2. 对可用 snapshot 调用既有 `restore(connectionId)`，加载 index 到 `SchemaRagEngine`。
3. 对 invalid snapshot 只记录诊断，不抛出。
4. 如果传入连接过滤器，只恢复指定连接；invalid snapshot 仍会报告，便于后续清理。
5. 未配置 snapshot store 时返回空结果，保持内存模式可用。

## 恢复策略

- 批量恢复不改变 snapshot 格式，不引入迁移。
- 单连接恢复复用已有 `restore` 逻辑，继承损坏文件隔离和 failed status 行为。
- 批量入口只做编排和诊断聚合，不改变检索排序或文档构建逻辑。

## 开源与依赖评估

本切片没有新增第三方依赖。当前能力属于启动恢复编排，现有 JSON snapshot store 和内存索引已经满足目标。引入 sqlite-vec、LanceDB、Chroma 或 LlamaIndex/LangChain retriever 会带来 native 打包、模型/向量存储迁移、离线安装和 Electron 分发成本，不适合本切片。后续向量检索应作为 adapter 层新增，不影响当前 snapshot 合同。

## 测试覆盖

- 使用真实临时文件系统保存两个连接的 schema snapshot，再通过新 `SchemaRagEngine` 批量恢复。
- 写入损坏 snapshot，验证返回 `invalidSnapshots` 且不阻断其他连接恢复。
- 使用连接过滤器，只恢复指定连接。
- 未配置 snapshot store 时返回空结果。

## 已知限制

- 当前批量恢复仍基于 JSON snapshot，不是 SQLite/FTS/向量持久层。
- 当前恢复是同步串行流程；大规模连接场景后续可以增加并发限制和取消信号。
