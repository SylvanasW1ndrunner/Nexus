# BetaV0.1.1 - Schema RAG 状态工具

## 版本范围

本版本为 Agent/RAG 后端能力增加只读状态检查入口，不涉及前端 UI。

## 变更内容

- `packages/core-agent/src/schema-rag-tools.ts` 新增 `get_schema_rag_status`。
- `packages/core-agent/test/schema-rag-tools.test.ts` 覆盖 ready / idle 两类状态。
- `packages/core-tools/src/official-plugin-registry.ts` 的 `official.schema-rag` 新增 `schema-rag-status` capability 和工具声明。
- `packages/core-tools/test/official-plugin-registry.test.ts` 更新默认工具清单和权限过滤断言。
- 更新 `docs/engineering/modules/core-agent.md`、`docs/engineering/modules/core-tools.md` 和本切片文档。

## 用户价值

Agent 后续执行真实数据库任务前，可以先读取连接级 Schema RAG 索引状态，判断是否已经恢复、是否 ready、是否需要等待或降级到实时 schema 工具。这让启动恢复和渐进索引从“后台行为”变成可被 Agent 策略层使用的稳定信号。

## 安全与插件边界

- 工具风险等级：`safe`。
- 工具只读：是。
- 使用权限：`rag.schema.read`。
- 网络访问：无。
- 进程访问：无。
- 密钥访问：无。

该能力归属于官方 `official.schema-rag` 插件，不作为独立插件。它只声明和调用已有 core 合同，没有新增依赖。

## 验证计划

- `pnpm exec vitest run packages/core-agent/test/schema-rag-tools.test.ts`
- `pnpm exec vitest run packages/core-tools/test/official-plugin-registry.test.ts`
- `pnpm --filter @dbagent/core-agent typecheck`
- `pnpm --filter @dbagent/core-tools typecheck`
- `pnpm --filter @dbagent/core-agent lint`
- `pnpm --filter @dbagent/core-tools lint`
- `pnpm --filter @dbagent/core-agent test`
- `pnpm --filter @dbagent/core-tools test`
- `pnpm turbo typecheck`
- `pnpm turbo lint`
- `pnpm turbo test --concurrency=1`
- `pnpm smoke`
- `git diff --check`
- 提交前 secret 扫描

## 已知限制

- 当前工具只读取本地内存/恢复后的索引状态，不主动触发 catalog 索引。
- 桌面主进程是否在启动后完成恢复仍由已有 startup recovery 流程负责。
- 正式 UI 冻结，后续状态展示入口在前端统一重建阶段再设计。
