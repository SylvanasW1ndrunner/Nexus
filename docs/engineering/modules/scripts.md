# scripts 工程脚本模块

## 代码入口

- `scripts/smoke.mjs`：零外部依赖的仓库健康检查。
- `scripts/run-postgres-tests.mjs`：真实 PostgreSQL 集成测试入口。
- `scripts/prune-asar.cjs`：Electron 打包后 ASAR 裁剪。
- `scripts/dev-db/*`：本地 PostgreSQL fixture 和 Docker Compose 开发环境。
- `scripts/clean-path.mjs`：构建前清理输出路径。

## 开发逻辑

脚本模块服务工程流水线，不属于用户运行时能力。所有 fixture、Docker 配置、测试 loader 和发布检查都必须留在仓库脚本层，不能进入最终桌面安装包。

`smoke.mjs` 是快速健康检查，用于在没有数据库、没有外部服务时确认关键文件、SQL 安全关键词和 IPC 片段仍存在。它不能替代单元测试或真实数据库测试，但可以快速发现明显结构性破坏。

`run-postgres-tests.mjs` 显式设置 `DBAGENT_RUN_POSTGRES_TESTS=1` 后运行 `postgres.integration.test.ts`。这样普通 `pnpm test` 不会因为本机没有 PostgreSQL 而失败，但发布候选可以明确运行真实数据库测试。

`prune-asar.cjs` 是打包质量的一部分。workspace 包在 Electron 打包时容易把源码、测试、`.turbo`、`tsconfig.tsbuildinfo` 和 source map 带进 ASAR；裁剪脚本负责把这些开发产物剔除，降低安装包体积和源码暴露风险。

`dev-db` 提供标准开发 fixture，默认数据库是 `dbagent_demo`，用户、密码均为 `postgres`。这套 fixture 只服务开发和测试，不意味着用户需要本地安装 PostgreSQL；真实产品场景是桌面客户端连接本机或远程服务器数据库。

## 测试与验证命令

快速质量门禁：

```bash
pnpm run ci
```

真实 PostgreSQL：

```bash
pnpm db:up
pnpm test:postgres
pnpm db:down
```

桌面打包：

```bash
pnpm --filter @dbagent/desktop package
```

打包后还必须启动 `win-unpacked/DBAgent.exe` 并检查 ASAR 内容，不能只相信 build 成功。

## 后续扩展

- CI 环境具备 Docker 后，评估把 `pnpm test:postgres` 加入候选发布门禁。
- 发布脚本应输出安装包大小、ASAR 裁剪统计、启动验证结果和签名状态。
- 跨平台发布前，需要分别验证 Windows、macOS、Linux 的 `safeStorage`、安装包路径和远程数据库连接行为。
