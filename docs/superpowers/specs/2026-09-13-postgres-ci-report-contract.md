# PostgreSQL CI 报告契约

## 目标

让 `pnpm test:postgres` 只为当前实际执行的 PostgreSQL 集成测试生成可审计证据，并让 CI 的
`postgres-acceptance-*` artifact 包含同一次运行的功能、性能和清单报告。

## 功能报告边界

功能套件固定为 runner 依次执行的三个真实测试文件：

1. `packages/core-db/test/postgres.integration.test.ts`
2. `packages/core-db/test/postgres-connector.integration.test.ts`
3. `packages/agent-host/test/database-agent-postgres.integration.test.ts`

每个文件只有在其 Vitest 子进程以零状态退出后才记录为通过。第三项由 runner 根据
`DBAGENT_TEST_PG_*` 组装并传入 `SCHEMANAUT_TEST_POSTGRES_URL`，其中用户名和密码必须作 URL 编码。
runner 在三项均成功后写入
`reports/postgres-scenarios/functional.json`；报告必须使用本次 runner 创建的 `runId`，标明
`dbagent_core_db_test`、三个 test file、每项 `passed: true`，并如实给出
`expectedSuiteCount: 3` 与 `actualSuiteCount: 3`。

已删除的 SDK 语义场景不在该报告中复活，也不得以旧的 11 项计数、占位测试或合成结果替代当前运行的测试。

## 清单和性能边界

性能套件继续独立生成 `performance.json`。`manifest.json` 继续要求 `functional.json` 与
`performance.json` 均属于相同的 `runId` 且 `passed: true`，并记录两者的 SHA-256。因此缺失的
功能报告必须使 runner 失败，不能被静默忽略。

`packages/agent-host/test/postgres.integration.test.ts` 与
`packages/agent-host/test/postgres-scenarios.integration.test.ts` 是不执行行为的环境门控占位入口，runner
不得将它们纳入功能套件。

## Live 验收入口

`run-multi-model-agent-live-test.mjs` 属于已删除 SDK 路径的失效入口：它依赖上述占位测试和旧的
`live-cases` 布局。该 runner、对应 package script 以及两个占位测试都应删除。真实的 live Database
验收仅由 `run-unified-agent-live-test.mjs` 调度，并在
`packages/agent-host/test/database-analysis.live.integration.test.ts` 执行；脚本合同只保留该统一入口的契约。

## 验收

- 脚本合同测试从干净报告目录验证功能报告有三个 suite、文件集合准确、数据库和 runId 正确。
- `pnpm test:postgres` 成功时生成 `functional.json`、`performance.json` 与 `manifest.json`；三者的
  runId 一致，且功能、性能和清单均为通过。
- CI artifact 上传发生在上述命令成功之后。
