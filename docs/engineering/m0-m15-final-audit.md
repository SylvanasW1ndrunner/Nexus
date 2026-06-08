# M0-M1.5 候选验收审计

> 审计日期：2026-06-08。审计分支：`codex/m0-m1-foundation`。最近功能提交：`1c93114`。本记录用于最终验收前核对，不替代候选发布时重新运行质量门禁。

## 审计结论

M0-M1.5 已达到候选验收状态。当前实现已经覆盖产品文档中 M0 的仓库和桌面骨架要求、M1 的 PostgreSQL 可连可查要求，并补充了 M1.5 所需的 Schema 浏览、查询历史、导出、安全确认、远程连接诊断、真实 PostgreSQL 集成测试和打包验证。

以下事项不阻塞 M0-M1.5，但进入公开用户包前仍需要专项处理：应用图标、代码签名、跨平台 OS keychain QA、弱网/防火墙/VPN 手工 QA、完整桌面 E2E。

## 用户要求核对

| 用户要求 | 当前证据 | 结论 |
|---|---|---|
| 自主开发 M0 到 M1.5 | `apps/desktop`、`packages/*`、`scripts/*`、多轮功能提交 | 已满足 |
| 根据业务需求撰写测试 | `packages/*/test`、`apps/desktop/src/**/*.test.ts`、`docs/engineering/test-strategy.md` | 已满足 |
| 文档集中留存 | `docs/engineering`、`docs/product` | 已满足 |
| 文档使用中文 | `docs/engineering/*.md`、`docs/engineering/modules/*.md` | 已满足 |
| 每次阶段内容提交 GitHub | 分支提交记录：`a379cfe` 到 `1c93114` | 已满足 |
| 真实 PostgreSQL 测试 | `pnpm test:postgres`、`postgres.integration.test.ts` | 已满足 |
| 回滚和复杂 SQL 场景 | `postgres.integration.test.ts`、`sql-performance.test.ts` | 已满足 |
| 远程数据库连接问题 | `postgres-errors.test.ts`、`postgres-driver-runtime-errors.test.ts`、renderer diagnostics | 已满足 |
| 考虑后续多数据库/ORM | `DatabaseDriverRegistry`、`IDatabaseDriver`、`docs/engineering/modules.md` | 已满足 |
| 最终要打包给用户，依赖需谨慎 | `apps/desktop/package.json`、`scripts/prune-asar.cjs`、`scripts/verify-package.mjs`、`docs/engineering/packaging.md` | 已满足 |
| 留存接口文档、测试文档、模块文档 | `interfaces.md`、`test-strategy.md`、`modules/*.md` | 已满足 |

## 功能证据

| 阶段 | 要求 | 当前证据 |
|---|---|---|
| M0 | monorepo、TS、ESLint、测试门禁 | `pnpm-workspace.yaml`、`turbo.json`、`tsconfig.base.json`、`eslint.config.mjs`、`pnpm run ci` |
| M0 | Electron + Vite + React 桌面骨架 | `apps/desktop`、`apps/desktop/src/main/main.ts`、`apps/desktop/src/renderer/src/App.tsx` |
| M0 | shared IPC 契约 | `packages/shared/src/ipc.ts`、`packages/shared/test/ipc-contract.test.ts` |
| M1 | PostgreSQL driver 与连接池 | `packages/core-db/src/postgres-driver.ts` |
| M1 | 连接 CRUD 与凭证隔离 | `ConnectionStore`、`CredentialVault`、`connection-workflow.test.ts` |
| M1 | SQL 执行与结果展示 | `createQueryWorkflow`、`PostgresDriver.execute`、renderer `ResultTable` |
| M1 | 基础认证/用量骨架 | `packages/core-auth`、`packages/core-usage`、`auth:*` 和 `usage:*` IPC |
| M1.5 | Schema 浏览与表详情 | `schema-workflow.ts`、`PostgresDriver.listTables`、`PostgresDriver.describeTable` |
| M1.5 | 查询历史 | `QueryHistoryStore`、renderer history panel |
| M1.5 | CSV/JSON 导出 | `queryResultToCsv`、`queryResultToJson` |
| M1.5 | 危险 SQL 确认和只读拦截 | `analyzeSqlSafety`、`confirmationRequiredError`、`query-workflow.test.ts` |
| M1.5 | EXPLAIN 安全入口 | `explain-workflow.ts`、`explain-workflow.test.ts` |
| M1.5 | 远程连接与运行期中断分类 | `postgres-errors.ts`、`postgres-driver-runtime-errors.test.ts` |
| M1.5 | 工作区状态恢复 | `WorkspaceStateStore`、`workspace-state-store.test.ts` |
| M1.5 | 打包产物验证 | `pnpm package:dir`、`pnpm package:verify`、`verify-package.mjs` |

## 测试证据

最近一次本地候选验证已通过：

```bash
pnpm run ci
pnpm test:postgres
pnpm package:dir
pnpm package:verify
```

覆盖重点：

- 快速测试：shared 5 个、core-auth 4 个、core-usage 4 个、core-db 34 个、desktop 40 个，共 87 个通过。
- 真实 PostgreSQL：`postgres.integration.test.ts` 2 个测试通过，覆盖连接、Schema、表详情、join 查询、只读拦截、断连、事务回滚。
- 打包验证：Windows unpacked 产物启动探活通过，ASAR 文件数 315，且验证脚本检查构建输入新鲜度，避免误验旧包。

## 多数据库与 ORM 决策

用户数据库接入不使用 ORM 作为主抽象，而使用 `IDatabaseDriver` 和 `DatabaseDriverRegistry`。原因是 DBAgent 面向用户已有数据库，需要保留任意 SQL、原生错误、Schema metadata、EXPLAIN、权限行为和数据库方言差异。ORM 未来可以用于 DBAgent 自身本地配置库，但不应作为用户数据库访问层。

后续新增 MySQL、ClickHouse、SQL Server 等数据库时，应实现新的 driver，并在 registry 注册 factory 与 capability；main、renderer、查询历史、导出和安全报告继续依赖统一接口。

## 候选验收建议

最终人工验收建议按以下顺序执行：

```bash
pnpm run ci
pnpm test:postgres
pnpm package:dir
pnpm package:verify
```

随后从打包产物执行一次桌面走查：创建 PostgreSQL 连接、连接真实数据库、浏览 Schema、执行 SELECT、触发只读拦截、确认写操作、导出 CSV/JSON、重启恢复 SQL 草稿。
