# BetaV0.1.1 PostgreSQL 集成测试入口修正

## 背景

当前开发环境没有 `pnpm` 命令，但仓库内已经有可用的 `node_modules/vitest/vitest.mjs`。原 `scripts/run-postgres-tests.mjs` 只通过 `pnpm exec vitest` 启动，导致没有 pnpm 的机器无法运行真实 PostgreSQL 集成测试入口。

## 实现内容

- `scripts/run-postgres-tests.mjs` 优先使用当前 Node 进程直接执行本地 Vitest。
- 如果本地 Vitest 不存在，才回退到 `pnpm exec vitest`。
- Windows 下只有 pnpm fallback 才启用 shell，避免 Node 直启时出现 shell 参数安全警告。
- 启动 Vitest 前会先检查 PostgreSQL 测试库 TCP 端口是否可达；不可达时输出短提示并退出，避免刷出长测试栈。

## 本轮实测

已运行：

```powershell
node scripts/run-postgres-tests.mjs
```

结果：本机没有运行中的 PostgreSQL 服务，默认 `127.0.0.1:5432` 连接被拒绝。脚本现在会在测试前置阶段直接提示数据库不可达。该失败不是 mock 或测试入口问题，而是测试依赖的数据库服务缺失。

## 复跑要求

启动 PostgreSQL 后复跑：

```powershell
$env:DBAGENT_TEST_PG_HOST='127.0.0.1'
$env:DBAGENT_TEST_PG_PORT='5432'
$env:DBAGENT_TEST_PG_DATABASE='dbagent_demo'
$env:DBAGENT_TEST_PG_USER='postgres'
$env:DBAGENT_TEST_PG_PASSWORD='postgres'
node scripts/run-postgres-tests.mjs
```

账号模块也可单独用 `DBAGENT_TEST_AUTH_DATABASE_URL` 指向认证测试库。

## 后续优化

- 增加一键本地 PostgreSQL fixture 启动脚本。
- 在无 PostgreSQL 服务时输出更短、更可操作的前置条件提示。
