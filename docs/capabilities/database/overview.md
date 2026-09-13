# Database Capability

## 功能

Database Capability 是可选、与其他 Capability 平等的数据库能力包。它通过通用 Capability 注册协议向 Agent 提供连接状态、数据库工具、Schema 知识与结果引用；Agent 内核不拥有连接器、Schema RAG 或 SQL 运行时。本文描述内部实现与测试边界，不是终端用户指南。

当前内部实现与测试覆盖的连接器是 PostgreSQL。合同允许扩展连接器，但本文不承诺其他数据库已经可用。
标准环境连接生成的 Profile 必须引用内置 Connector 的稳定注册标识 `postgres-native`；引擎名
`postgres` 不能代替 Connector ID。

内部数据面管理 Profile、Session、连接健康、资源发现、查询、事务、结果、审计与指标。首次激活连接后，
模块先恢复已有 Schema 快照；没有可用快照时立即构建有界索引，再一次性发布可查询、可检索的 Tool
generation。不能发布一组会稳定返回“先建索引”却又没有 Agent 索引入口的工具。内部状态同时给出
`connected`、Schema 状态和 `agentPublication`：后者为 `pending` 表示物理连接或 Schema 已变化，但对应
Agent Capability generation 尚未发布完成。

## 设计

模块只依赖狭窄的 Host Port：项目身份、模型调用以及 Capability 的 activate/refresh/deactivate 请求。它不会取得 Agent Runtime、Journal、设置或可变 Tool Registry。数据库资源由 `core-db` 管理，Schema 知识由 `core-rag` 管理，跨包数据合同位于 `shared`。

每个已发布工具 generation 都捕获不可变的 active binding：`profileId`、`connectionId`、只读标志和 Schema 的只读视图。连接、重连、断开和切换取得写栅栏；同一 binding 的查询与 Schema 读取可并发取得读栅栏。写操作排队后，新的旧 generation 读取会得到可重试的 `CONNECTION_FAILED`，而已开始的读取先排空。这样旧工具不会被静默路由到新物理 session。

物理重连成功但 Agent publication 失败时，模块保留真实的新 session，并将状态标成 `agentPublication: 'pending'`；后续重连只重试 publication，不伪造旧连接。首次连接若 publication 失败则断开新物理 session 再删除临时 Profile。

## 效果与边界

- Database Capability 可以不组合、不激活；没有该 Capability 的 Agent 仍可完整运行通用内核。
- Capability 没有项目内或程序内配置。数据库前置条件来自外部 CLI、文件、环境或安全引用；缺失时
  应返回可行动原因，并可在条件变化后重新 probe 或重试。
- 数据库连接、Profile、Schema 索引与 SQL 执行仅在内部 Host 实现和测试中可达；终端入口仍待完善。
- 数据库连接、Profile 和资源目录不是 Agent 内核状态，也不通过通用模型上下文泄漏。
- 连接有效不等于 Agent generation 已就绪：调用方应观察 `agentPublication`。
- active binding 是单模块内的进程级一致性边界，不替代数据库服务端的事务、锁或权限控制。
- Profile、Session 与结果合同属于 Host/Capability 内部数据面；当前终端不提供 SDK 或 HTTP 数据平面，也不会暴露原始 Runtime、模块实例或注册表。
- 跨工具分析通过通用 Agent 组合完成：Database Capability 产出有界预览和 Runtime 结果引用；基础
  `result_read` 只供模型检查有界样本，`result_materialize` 将完整原始 NDJSON 以 Run-scoped 临时路径交给
  项目内 Python 或其他本地 Tool，`result_save` 仅在用户明确要求保存、导出、保留或生成文件时写入工作区。
  临时物化会在 Run 终态清理，Host 启动会回收崩溃遗留；持久保存是 Agent 行为合同，不是 Capability 策略、
  自然语言强制或第四种权限模式。Database Capability 不负责 Python 包安装，也不新增分析运行时配置。

## 场景

1. 外部前置条件就绪后，内部 Host 创建或选择 Profile；模块连接数据库，恢复或构建该连接的有界 Schema
   索引，再请求发布数据库 Capability。
2. Agent 的下一轮按动态发现加载数据库工具。工具 generation 固定引用该连接和当时 Schema read view。
3. 同时有查询在运行时，发起重连会等待这批读取结束；后到的旧 generation 调用被拒绝并提示用下一 generation 重试。
4. 重连后的 publication 暂时失败时，Host 保留真实连接和 `pending` 状态，修复发布条件后可重试，无需再次建立物理连接。

## 代码与测试

- [Capability 模块与连接发布](../../../packages/database-capability/src/database-capability-module.ts)
- [active binding 读写栅栏](../../../packages/database-capability/src/active-binding-gate.ts)
- [狭窄 Host Port](../../../packages/database-capability/src/host-port.ts)
- [共享数据库合同](../../../packages/shared/src/contracts/database.ts)
- [发布失败、重连、栅栏与 freshness 测试](../../../packages/database-capability/test/database-capability-module.test.ts)
- [通用 Agent + 真实 PostgreSQL 动态激活与长结果测试](../../../packages/agent-host/test/database-agent-postgres.integration.test.ts)
- [真实模型数据分析验收合同](../../engineering/real-model-data-analysis-acceptance.md)
