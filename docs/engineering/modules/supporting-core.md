# auth / usage / llm 支撑模块

## 代码入口

- `packages/core-auth/src/auth-service.ts`：认证状态和会话持久化骨架。
- `packages/core-usage/src/usage-tracker.ts`：本地用量记录。
- `packages/core-llm/src/llm-router.ts`：LLM provider 路由边界。

## 开发逻辑

这些模块在 M1.5 阶段不是完整商业化能力，而是为 BYOK、订阅和后续 Agent 留下稳定边界。

`core-auth` 当前提供登录、登出和状态读取的本地状态机。它不绑定真实后端，不阻塞用户使用本地数据库能力。这样 BYOK 用户即使未登录，也能连接数据库、执行 SQL 和保存本地工作区。未来接入服务端认证时，UI 面向的 `AuthService` 返回结构应保持稳定。

`core-usage` 当前记录本地查询轮次和历史窗口。它服务两个方向：一是 M1.5 让用户看到基础用量状态，二是后续订阅模式或 gateway 模式接入时，不需要重做 UI 和状态边界。未来 Agent loop 上线后，每轮 Agent 对话也应通过该模块计量。

`core-llm` 当前只保留路由接口，不引入模型 SDK 和远程依赖。M1.5 的重点是数据库桌面基础能力，过早接入 LLM SDK 会增加打包、凭证和网络变量。真实 LLM provider 应从 M2/M3 开始，以 BYOK provider 和 DBAgent gateway provider 两条路径实现。

## 测试覆盖

- `packages/core-auth/test/auth-service.test.ts`：登录后状态持久化、登出后状态清理、未登录状态表达。
- `packages/core-usage/test/usage-tracker.test.ts`：本地查询轮次递增、快照读取和历史记录。
- `core-llm` 当前不强行扩展测试，等 provider 行为落地后补真实 provider contract test 和 API eval。

## 后续扩展

- `core-auth`：接入远程 token、刷新、组织信息和离线降级策略。
- `core-usage`：区分本地 SQL、Agent 对话、RAG indexing 和 gateway 调用。
- `core-llm`：实现 BYOK、gateway、模型能力声明、错误分类和速率限制处理。
