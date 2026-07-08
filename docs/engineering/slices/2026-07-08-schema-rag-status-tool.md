# 2026-07-08 Schema RAG 状态工具切片

## 背景

当前开发路线是先完成后端功能，前端 UI 保持冻结。上一轮已经把桌面启动期的 Schema RAG 快照恢复、无主快照清理和连接删除清理接入主进程。恢复完成后，Agent 需要一个稳定的只读入口来判断某个连接的 RAG 索引是否 ready，而不是通过 `search_schema` 的结果间接推断。

## 实现范围

- `core-agent` 新增 Agent 工具 `get_schema_rag_status`。
- 工具直接调用 `SchemaRagEngine.getIndexStatus(connectionId)` 兼容的服务合同。
- `core-tools` 的 `official.schema-rag` manifest 新增 `schema-rag-status` capability 和同名工具声明。
- 不改 renderer UI，不新增 IPC，不新增数据库或 LLM 调用。

## 工具合同

输入：

- `connectionId`：可选。如果注册工具时传入 `defaultConnectionId`，可以省略；否则必须显式传入。

输出：

- `connectionId`
- `stage`：`idle` / `skeleton` / `hot_tables` / `long_tail` / `ready` / `failed`
- `ready`
- `documentCount`
- `tableCount`
- `columnCount`
- `relationCount`
- `glossaryCount`
- `indexedAt`
- `updatedAt`
- `stages`

## 开源方案评估

本切片是状态暴露和权限声明，不涉及复杂检索、向量存储、embedding、rerank、Agent 编排或观测系统，因此没有引入新的开源依赖。继续复用 DBAgent 已有的 `SchemaRagEngine`、`ToolRegistry` 和官方插件 manifest。

后续如果要把状态展示、trace、RAG 质量评估或向量索引做成更完整能力，应优先评估成熟项目，并通过 adapter 或官方插件接入，不能把第三方框架类型暴露为 core 包公共合同。

## 验收标准

- Agent 工具清单包含 `get_schema_rag_status`。
- 已索引连接返回 `stage: "ready"` 和 `ready: true`。
- 未索引连接返回 `stage: "idle"` 和 `ready: false`，不会触发 search 异常。
- 官方插件策略能把该工具作为 `official.schema-rag` 的只读安全工具解析出来。
- 默认测试不需要 PostgreSQL、LLM key 或前端 UI。
