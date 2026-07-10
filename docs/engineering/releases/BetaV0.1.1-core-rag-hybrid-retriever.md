# BetaV0.1.1：core-rag 混合检索

## 范围

本版本切片增强 `core-rag` 的默认检索能力，不涉及前端 UI 和多数据库。

新增能力：

- 默认混合检索模块。
- 显式引用、关键词、业务术语融合排序。
- 一跳/多跳图扩展合同。
- 检索结果 `scoreDetails`，用于评估与调试。
- quoted identifier 点号解析。
- snapshot 恢复后的 hybrid 检索一致性测试。

## 兼容性

- `SchemaRagEngine.search()` 调用方式保持兼容。
- `SchemaRagSearchResult` 只新增可选字段 `scoreDetails`。
- 未新增运行时依赖。
- 项目级 pnpm build script 白名单明确化，包含当前已有 `electron`、`esbuild`、`node-pty`。

## 验证结果

- `core-rag`：8 个测试文件，55 个测试通过。
- `core-agent` 类型检查通过。
- `core-tools` 类型检查通过。
- 业务 RAG Agent 场景：9 个默认测试通过，4 个门控测试跳过。
- `pnpm test:postgres` 通过：真实 PostgreSQL 覆盖 core-db、desktop query workflow、core-auth、core-tools 业务 RAG fixture。
- `pnpm test:agent-rag-live` 通过：真实 SiliconFlow `deepseek-ai/DeepSeek-V4-Pro` 调用。
- `DBAGENT_RUN_AGENT_RAG_LIVE_POSTGRES=1 pnpm test:agent-rag-live` 通过：真实模型 + 真实 PostgreSQL 业务 fixture。

## 已知限制

- 尚未接入 SQLite FTS5 / sqlite-vec。
- 尚未接入 embedding provider 和 reranker。
- 渐进索引仍未真实分阶段读取 catalog。
- LLM live test 和 PostgreSQL live test 不作为本切片默认门禁。
