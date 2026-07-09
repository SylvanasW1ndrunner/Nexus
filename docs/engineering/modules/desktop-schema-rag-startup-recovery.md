# desktop Schema RAG 启动恢复接线

## 目标

本模块把 core-rag 的批量启动恢复能力接入 desktop 主进程，并提供一个官方只读诊断工具，方便 Agent 和后续 UI 查看最近一次启动恢复结果。

## 接口边界

- `core-rag`：
  - `ProgressiveSchemaRagIndexer.restoreAll` 负责扫描并恢复 snapshot。
  - `SchemaRagSnapshotStore.cleanupInactive` 负责清理非活动连接和损坏 snapshot。
- `apps/desktop/src/main/schema-rag-startup-cleanup.ts`：
  - 负责组合连接列表、snapshot 清理和 `restoreAll`。
  - 输出 `SchemaRagStartupRecoverySummary`。
- `apps/desktop/src/main/main.ts`：
  - 创建共享 `ProgressiveSchemaRagIndexer`。
  - 启动后执行恢复，并保存最近一次 summary。
- `apps/desktop/src/main/agent-tool-bootstrap.ts`：
  - 注册 `get_schema_rag_startup_recovery` 官方只读工具。

## 启动流程

1. 读取当前保存的连接列表。
2. 清理不属于活动连接的 snapshot；默认移除 invalid snapshot。
3. 调用 `restoreAll({ connectionIds })` 恢复活动连接的 RAG index。
4. 聚合恢复结果：
   - `loadedCount`
   - `missingCount`
   - `invalidCount`
   - `errorCount`
   - `restoredConnectionIds`
   - `failedConnectionIds`
   - `invalidSnapshotPaths`
5. 将 summary 写入内存，供诊断工具读取。

## 官方工具

`get_schema_rag_startup_recovery`

- 来源：`official.schema-rag`
- 权限：`rag.schema.read`
- 只读：是
- 返回：
  - `available`: 当前进程是否已有启动恢复摘要。
  - `summary`: 最近一次启动恢复摘要；未执行时为 `null`。

## 开源与依赖评估

本切片没有新增依赖。当前目标是 desktop 编排和诊断，直接复用项目内 `ProgressiveSchemaRagIndexer` 与 `SchemaRagSnapshotStore`。暂不引入 sqlite-vec、LanceDB、Chroma、LlamaIndex 或 LangChain，避免扩大 native 打包、离线安装和 adapter 迁移风险。

## 测试覆盖

- 启动恢复调用 `restoreAll`，并按活动连接过滤恢复范围。
- 清理失败时仍尝试恢复活动连接。
- 缺失、损坏和失败 snapshot 被正确聚合到 summary。
- 官方只读工具能返回最近一次启动恢复摘要。
- 官方插件 manifest 能识别新增工具并纳入权限策略。

## 已知限制

- summary 当前保存在主进程内存，应用重启后会重新生成。
- 本切片不实现 renderer UI 展示。
- 默认启动清理会移除 invalid snapshot，因此工具通常通过 `removedInvalidCount` 观察启动清理结果。
