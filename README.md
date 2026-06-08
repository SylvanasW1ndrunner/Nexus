# DBAgent

DBAgent 是面向数据工程师的 Agent 原生数据库 IDE。当前以本地优先的 Electron 桌面应用切入，先支持 PostgreSQL 连接、SQL 执行和结果展示，后续逐步扩展 Schema RAG、Agent 执行、MCP 工具、Skill 系统和工作区 Python 产物。

当前阶段文档统一使用中文；英文文档等产品主线开发完成后再集中整理。

## 仓库结构

- `apps/desktop`：Electron + React 桌面客户端。
- `packages/shared`：共享领域类型、Result 模型和 IPC 契约。
- `packages/core-db`：数据库驱动抽象、PostgreSQL 驱动、SQL 安全、连接存储和查询历史。
- `packages/core-auth`：订阅集成前的本地认证/会话骨架。
- `packages/core-usage`：BYOK 与订阅模式共用的用量记录骨架。
- `packages/core-llm`：BYOK 与后续 gateway 模式共用的 LLM 路由边界。
- `docs/product`：产品与架构设计文档。
- `docs/engineering`：接口、测试、打包和运维相关工程文档。

## 常用命令

```bash
pnpm install
pnpm dev
pnpm typecheck
pnpm lint
pnpm test
pnpm smoke
pnpm run ci
pnpm --filter @dbagent/desktop build
pnpm --filter @dbagent/desktop package
```

当前开发机需要安装 Node.js 和 pnpm，或通过 Corepack 提供。桌面端打包策略要求开发/测试专用依赖留在最终 Electron 应用包之外。
