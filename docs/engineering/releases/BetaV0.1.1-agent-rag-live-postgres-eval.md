# BetaV0.1.1 - Agent/RAG live PostgreSQL 组合验收

## 变更摘要

本版本补齐 Agent/RAG 发布前强门禁：在同一个用例中使用真实 PostgreSQL、真实 Schema RAG 索引和真实 SiliconFlow `deepseek-ai/DeepSeek-V4-Pro` 模型，验证 Agent 能完成数据库分析工具链。

该能力不影响默认测试。只有显式设置 `DBAGENT_RUN_AGENT_RAG_LIVE_POSTGRES=1` 时才运行组合门禁。

## 影响范围

- `packages/core-tools/test/agent-rag-business-scenario.test.ts`
- `scripts/run-agent-rag-live-tests.mjs`
- `docs/engineering/test-strategy.md`
- `docs/engineering/modules/core-tools.md`
- `docs/engineering/slices/2026-07-08-agent-rag-live-postgres-eval.md`

## 安全边界

- SiliconFlow API key 只从环境变量读取。
- 脚本报告不写 API key、数据库密码或连接串。
- 测试库自动重建只允许 `dbagent_*_test` 命名。
- Agent 运行白名单只开放 `search_schema` 和 `query_database`。
- `query_database` 继续在工具 handler 内执行只读 SQL 审计。

## 验证记录

已完成：

```powershell
pnpm exec vitest run packages/core-tools/test/agent-rag-business-scenario.test.ts
pnpm turbo typecheck --filter=@dbagent/core-tools
pnpm test:postgres
$env:DBAGENT_RUN_AGENT_RAG_LIVE_POSTGRES='1'; pnpm test:agent-rag-live
pnpm turbo typecheck
pnpm turbo lint
pnpm turbo test --concurrency=1
pnpm smoke
```

结果：

- 默认 Agent/RAG 业务测试通过：5 passed、4 skipped。
- 真实 PostgreSQL 门禁通过：core-db、desktop query cancel、core-auth、core-tools 真实数据库集成测试全部通过。
- 真实 SiliconFlow + 真实 PostgreSQL 组合门禁通过：7 passed、2 skipped；新增组合用例耗时约 51 秒。
- 全量 typecheck、lint、test、smoke 均通过。
- 仓库和 `tmp` secret 扫描没有命中测试 API key。
