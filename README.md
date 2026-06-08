# DBAgent

DBAgent 是面向数据工程师的 Agent 原生数据库 IDE。当前 M0-M1.5 以本地优先的 Electron 桌面应用切入，已具备 PostgreSQL 连接管理、SQL 执行、查询历史、Schema 表/视图列表、CSV 导出、工作区 SQL 草稿恢复、基础认证/用量骨架，以及打包验证所需的最小工程流水线。

当前阶段文档统一使用中文；命令、路径、包名、IPC channel 和 API 名称保留英文。

## 仓库结构

- `apps/desktop`：Electron + React 桌面客户端，包含 main、preload、renderer 和 `electron-builder` 配置。
- `packages/shared`：共享领域类型、`Result<T>`、IPC 契约和 CSV helper。
- `packages/core-db`：数据库驱动抽象、PostgreSQL 驱动、SQL 安全分析、连接存储、查询历史和 SQL builder。
- `packages/core-auth`：订阅集成前的本地认证/会话骨架。
- `packages/core-usage`：BYOK 与订阅模式共用的用量记录骨架。
- `packages/core-llm`：BYOK 与后续 gateway 模式共用的 LLM 路由边界。
- `scripts/dev-db`：本地 PostgreSQL fixture，供手工验证和 `pnpm test:postgres` 使用。
- `scripts/smoke.mjs`：零外部依赖的仓库健康检查。
- `scripts/prune-asar.cjs`：`electron-builder` `afterPack` 钩子，用于裁剪 ASAR 内的 workspace 源码和测试产物。
- `docs/product`：产品与架构设计文档。
- `docs/engineering`：接口、测试策略、打包和运维相关工程文档。

## 常用命令

```bash
pnpm install
pnpm dev
pnpm typecheck
pnpm lint
pnpm test
pnpm test:postgres
pnpm smoke
pnpm run ci
pnpm --filter @dbagent/desktop build
pnpm --filter @dbagent/desktop package:dir
pnpm --filter @dbagent/desktop package
```

## PostgreSQL fixture

启动本地测试库：

```bash
pnpm db:up
```

运行真实 PostgreSQL 集成测试：

```bash
pnpm test:postgres
```

清理本地测试库：

```bash
pnpm db:down
```

默认连接参数为 `127.0.0.1:5432`、database `dbagent_demo`、user `postgres`、password `postgres`。

当前开发机需要安装 Node.js 和 pnpm，或通过 Corepack 提供。运行 `pnpm db:up` 和 `pnpm test:postgres` 还需要本机具备 Docker。桌面端打包策略要求开发、测试、Docker fixture 和调试脚本留在最终 Electron 应用包之外。
