# 2026-07-21 Headless Runtime MVP 验收报告

## 验收对象

- 功能切片：SDK-first NL2SQL 本地可试用闭环
- 版本/分支：`BetaV0.1.1`
- 变更模块：`packages/sdk`、`apps/server`、`packages/core-db`、产品与工程文档
- 触达测试：SDK、Server、core-db、全仓默认测试、真实 PostgreSQL 门控
- 验收日期：2026-07-21

## 用户场景

- 目标用户：希望通过 SDK/API/MCP 集成数据库 Agent 的开发者，以及首批本地试用者。
- 工作流：配置自有 OpenAI-compatible 模型和 PostgreSQL，索引 Schema，输入中文问题，审阅 SQL/解释/证据/风险，明确执行并查看有限结果。
- 输入数据：本机 `dbagent_core_db_test` PostgreSQL fixture；默认测试使用 fake Provider。
- 外部依赖：PostgreSQL 16；真实模型门控为 opt-in。

## 已执行验证

- `pnpm build:mvp`：通过，Server 及全部依赖构建成功。
- `pnpm typecheck`：通过，24/24 个任务成功。
- `pnpm test:mvp`：通过，SDK 12 个默认测试、Server 3 个测试。
- `pnpm test`：解除桌面构建器沙箱目录限制后通过，24/24 个任务成功。
- `pnpm smoke`：通过。
- `pnpm test:postgres` 等价真实门控：通过。
  - core-db：6 个真实 PostgreSQL 测试。
  - desktop 查询取消：1 个测试。
  - core-auth：2 个测试。
  - core-tools 业务闭环：11 个通过、2 个真实模型项跳过。
  - sdk：1 个真实 PostgreSQL 闭环通过、1 个真实模型组合项跳过。
- 编译后 CLI：已启动并检查 `/health` 与 WebUI HTML。
- 本切片涉及的 `core-db`、`sdk`、`server` lint：通过。

## 功能与安全结论

- SDK、REST、CLI 和 WebUI 复用同一个 `DatabaseAgentRuntime`。
- 真实 PostgreSQL 可连接、抽取 Catalog、索引 Schema 并显式执行生成 SQL。
- 连接配置与 PostgreSQL 会话均强制只读。
- 写 SQL、多语句、可写 CTE、`SELECT INTO`、行锁和已知副作用函数有确定性阻断测试。
- API Key 和密码不落盘、不回显；本地 Server 只绑定 loopback。
- 生成与执行分离，执行接口只接受已保存 run id。
- 默认 200 行、硬上限 1000 行，默认连接超时 10 秒、语句超时 30 秒。

## 未覆盖与残余风险

- 真实模型 + 真实 PostgreSQL 组合门禁未执行。原因：该验证会把测试库 Schema 上下文发送到外部模型服务，本次没有获得明确的数据外发授权。门控代码已经存在，试用者确认后可设置 `DBAGENT_RUN_SDK_MVP_LIVE=1` 运行。
- 全仓 `pnpm lint` 仍被本切片开始前已存在的 `core-agent` 审批改动中的 5 个 lint 错误阻断；本切片没有覆盖或回退这些未提交改动。新增与修改的 MVP 包 lint 均通过。
- MVP run 和 Schema 索引仅在内存中，进程重启后需要重新配置与索引。
- 本地 Server 没有认证和 TLS，不得暴露到局域网或公网。
- 当前只支持 PostgreSQL 和 OpenAI-compatible Provider。

## 结论

- 验收结论：有条件通过，可交付本机 MVP 试用。
- 发布前条件：用无敏感数据的测试库完成一次经授权的真实模型组合门禁，并处理 `core-agent` 现有 lint。
- 下一步应根据试用反馈决定优先开发 MCP adapter、Verified Query、评测集还是只读运维诊断，不恢复复杂 IDE 前端路线。
