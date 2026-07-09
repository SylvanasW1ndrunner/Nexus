# 2026-07-09 Agent 输出安全硬阻断切片

## 范围

本切片只开发后端 core 能力，不开发前端 UI，不开发多数据库。

完成内容：

- `core-agent` 输出安全策略新增 `pii: 'block'`。
- 工具结果命中敏感信息时，转为可恢复工具失败，阻断原始结果进入上下文。
- 最终模型文本命中敏感信息时，返回 `safety_blocked`。
- 行为评估支持 `blocked` 工具期望。
- 业务场景测试覆盖电商客户统计中的行级 PII 泄露与聚合查询恢复。

## 验收结果

已通过：

- `tsc -p packages/core-agent/tsconfig.json --noEmit`
- `tsc -p packages/core-tools/tsconfig.json --noEmit`
- `eslint packages/core-agent packages/core-tools`
- `vitest run packages/core-agent/test/output-safety.test.ts packages/core-agent/test/react-agent.test.ts packages/core-agent/test/behavior-evaluation.test.ts packages/core-tools/test/agent-rag-business-scenario.test.ts --passWithNoTests`
- `vitest run packages/core-agent/test --passWithNoTests`
- `vitest run packages/core-tools/test --passWithNoTests`
- `node scripts/run-postgres-tests.mjs`

说明：

- `core-tools` 业务集成测试通过 workspace 包名导入 `@dbagent/core-agent`，需要先构建 `packages/core-agent/dist`，否则会使用旧 dist。
- 本切片没有新增第三方依赖。
- live LLM 测试仍按环境变量门控，不作为默认本地门禁强制项。

## 风险

- 启发式敏感识别可能误伤包含 `email_domain` 等聚合字段；当前通过聚合字段白名单降低误伤。
- 硬阻断会改变 Agent loop 语义，因此保持显式 opt-in。
- 后续应将字段注释、schema semantic type 和连接安全策略接入该模块。
