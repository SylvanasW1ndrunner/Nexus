# M0-M1.5 阶段验收记录

> 当前记录基于分支 `codex/m0-m1-foundation`，最近审计提交为 `5f2766a`。本文档用于阶段验收，不替代每次候选发布前重新执行质量门禁。

## 阶段范围

本阶段以产品文档中的 M0、M1 为硬边界，并在不引入重型依赖的前提下补充 M1.5 基础能力：

- M0：monorepo、Electron 桌面骨架、共享契约、core 包骨架、CI。
- M1：PostgreSQL 连接、SQL 执行、结果展示、连接 CRUD、基础认证/用量骨架。
- M1.5：Schema 浏览、表结构详情、查询历史、CSV/JSON 导出、危险 SQL 确认、真实 PostgreSQL 集成测试、远程连接诊断、打包产物验证、关键本地状态恢复。

Agent、RAG、MCP、Python 工作空间、表编辑器、表设计器、ER 图、真实订阅后端和自动更新不作为本阶段完成项。

## M0 验收

| 要求 | 当前证据 | 状态 |
|---|---|---|
| 初始化 monorepo | `pnpm-workspace.yaml`、`turbo.json`、根 `package.json` | 已完成 |
| TS / ESLint / 测试门禁 | `tsconfig.base.json`、`eslint.config.mjs`、`pnpm run ci` | 已完成 |
| Electron + Vite + React 桌面骨架 | `apps/desktop`，`pnpm dev`，`pnpm package:dir` | 已完成 |
| shared IPC 契约 | `packages/shared/src/ipc.ts` | 已完成 |
| core 包骨架 | `packages/core-db`、`core-auth`、`core-usage`、`core-llm` | 已完成 |
| GitHub Actions | `.github/workflows/ci.yml` 的 `verify` job | 已完成 |

说明：当前 UI 已超过空窗口要求，提供连接、Schema、SQL、结果和历史等 M1.5 工作区。

## M1 验收

| 要求 | 当前证据 | 状态 |
|---|---|---|
| `IDatabaseDriver` 接口 | `packages/core-db/src/types.ts` | 已完成 |
| PostgreSQL driver | `packages/core-db/src/postgres-driver.ts` | 已完成 |
| 连接池管理 | `PostgresDriver` 内部按 connection id 管理 pool | 已完成 |
| 连接 CRUD 持久化 | `ConnectionStore` + desktop IPC create/update/remove/list | 已完成 |
| 密码不进 renderer | `CredentialVault` + `connection-draft.test.ts` | 已完成 |
| IPC 连接能力 | `connection:test/create/update/remove/connect/disconnect/list` | 已完成 |
| SQL 执行 IPC | `db:execute-query`、`createQueryWorkflow` | 已完成 |
| 查询结果展示 | `apps/desktop/src/renderer/src/App.tsx` 结果表格 | 已完成 |
| 查询历史 | `QueryHistoryStore` + renderer history panel | 已完成 |
| 本地用量骨架 | `core-usage` + `usage:*` IPC | 已完成 |
| 认证骨架 | `core-auth` + `auth:*` IPC | 已完成 |
| LLM router 骨架 | `core-llm`，M1.5 不接真实模型 SDK | 已完成 |

说明：产品开发指南提到“后端服务最小版”，当前按桌面单机优先策略保留本地骨架和稳定 IPC，不在 M1.5 引入远程 Auth Service / LLM Gateway。该决策符合当前工程文档中“BYOK 用户不登录也能使用本地连接和 SQL 功能”的边界。

## M1.5 增强

| 能力 | 当前证据 | 状态 |
|---|---|---|
| Schema 表/视图列表 | `db:list-tables`、`PostgresDriver.listTables` | 已完成 |
| 表结构详情 | `db:describe-table`、主键/外键/注释 metadata | 已完成 |
| 预览 SQL 生成 | `buildTablePreviewSql`、renderer `SQL` 操作 | 已完成 |
| CSV 导出 | `queryResultToCsv`、`csv.test.ts` | 已完成 |
| JSON 导出 | `queryResultToJson`、`export.test.ts` | 已完成 |
| 危险 SQL 确认 | `confirmationRequiredError`、`query-workflow.test.ts` | 已完成 |
| 只读连接拦截 | `analyzeSqlSafety`、真实 PG 集成测试 | 已完成 |
| 写批次事务回滚 | `postgres.integration.test.ts` | 已完成 |
| 复杂 SQL 性能提示 | `sql-performance.test.ts` | 已完成 |
| 远程连接错误分类 | `postgres-errors.test.ts`、renderer diagnostics | 已完成 |
| 工作区状态恢复 | `WorkspaceStateStore`、损坏 JSON 降级 | 已完成 |
| 凭证存储边界 | `CredentialVault`、`safeStorage`/fallback 测试 | 已完成 |
| 本地 JSON 状态韧性 | `json-file.ts`、连接/历史损坏 JSON 降级测试 | 已完成 |

## 测试证据

阶段内已执行并通过：

```bash
pnpm install --frozen-lockfile
pnpm run ci
pnpm test:postgres
pnpm package:dir
pnpm package:verify
```

测试覆盖摘要：

- 单元测试：SQL 安全、SQL 性能提示、PostgreSQL 错误分类、SQL builder、连接 store、查询历史、CSV/JSON 导出、认证、用量、主进程查询链路、Schema 主进程链路、凭证 vault、工作区状态恢复、renderer diagnostics、连接草稿。
- 集成测试：`pnpm test:postgres` 连接真实 PostgreSQL，覆盖连接、Schema、表结构、join 查询、只读拦截、断连、事务回滚。
- CI：`.github/workflows/ci.yml` 包含 `verify` 和 `postgres-integration` 两个 job。

## 打包证据

当前打包入口：

```bash
pnpm package
pnpm package:dir
pnpm package:verify
pnpm package:verify:asar
```

关键约束：

- 根打包脚本会先执行 `pnpm build`，避免 workspace 依赖包产物缺失。
- `scripts/prune-asar.cjs` 裁剪 workspace 包源码、测试、source map 和构建缓存。
- `scripts/verify-package.mjs` 检查 ASAR 入口文件、开发残留和当前平台打包产物启动。
- 最近 Windows unpacked 验证显示 ASAR 文件数为 `315`，启动探活通过。

## 文档证据

工程文档均为中文，位于 `docs/engineering`：

- `interfaces.md`：IPC、driver、工作区状态、凭证、SQL 安全、Schema、导出。
- `modules.md`：总体模块开发逻辑。
- `modules/*`：分模块开发文档。
- `test-strategy.md`：测试分层、业务场景、质量门禁。
- `packaging.md`：依赖与打包策略。
- `m0-m15-acceptance.md`：本阶段验收记录。

## 发布前风险

以下不阻塞 M0-M1.5 工程验收，但不应在公开用户包发布前遗漏：

- 应用图标仍使用 Electron 默认图标。
- 安装包尚未配置代码签名。
- `CredentialVault` 在 `safeStorage` 不可用时使用 base64 fallback，这只是 M1.5 可用性兜底，正式公开发布前应接入 OS keychain adapter 并做跨平台 QA。
- 远程数据库弱网、VPN、云安全组、防火墙、SSL 策略仍需要手工 QA 矩阵。
- 当前没有 Playwright 驱动的完整桌面 E2E；已有主进程 workflow 测试、真实 PostgreSQL 集成测试和打包启动探活作为 M1.5 的自动化替代。

## 结论

从当前仓库证据看，M0、M1 和 M1.5 的桌面本地数据库基础能力已经达到可验收状态：能打包、能启动、能连接真实 PostgreSQL、能执行 SQL、能展示和导出结果，并且关键本地状态具备测试覆盖和恢复边界。

是否进入 M2，建议以产品验收者完成一次手工桌面走查为准：创建连接、连接本机或远程 PostgreSQL、浏览 Schema、执行 SELECT、触发只读拦截、确认写操作、导出 CSV/JSON、重启恢复草稿。
