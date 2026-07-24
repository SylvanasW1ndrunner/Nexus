# SchemaNaut 总体功能设计

## 1. 产品目标

SchemaNaut 是面向开发者、数据库管理员和企业数据团队的 AI 数据库系统：

> Vanna 式嵌入能力 + Wren 式知识增强 + ChatDBA 式数据库诊断 + AI 数据库治理与运维，并以国内模型、私有部署和明确权限为基础。

产品以 TypeScript SDK 和 REST API 为核心，通过 CLI 启动，通过轻量 WebUI 完成连接、模型、权限、知识和运行轨迹管理。不建设数据库 IDE，不包含工作区和复杂编辑器概念。

## 2. 服务方式

| 入口 | 作用 |
|---|---|
| SDK | 嵌入现有 Node.js 服务和开发工具 |
| REST API | 为其他语言和企业系统提供稳定接口 |
| CLI | 启动、配置、诊断和自动化 |
| WebUI | 轻量管理和试用 |
| MCP | 接入外部工具和上下文 |
| Skills | 导入用户工作方法与业务约束 |

## 3. 公共基础能力

### 3.1 大模型能力

- OpenAI-compatible、Anthropic、Ollama、国内云模型和私有模型。
- Chat、Tool Calling、结构化输出、Embedding 和 Reranker 合同。
- 模型目录与能力元数据查询，不发送探测 Prompt。
- 路由、超时、重试、缓存、审计和 Token/金额指标；消费上限仅在用户显式配置时启用。

文档：[大模型能力](foundation/01-llm-platform.md)

### 3.2 数据库接入

- PostgreSQL 为首个完整实现。
- 统一 Connector、Driver、连接、事务、查询、取消、EXPLAIN 和元数据接口。
- 从单节点扩展到集群、数据仓库和云平台。

文档：[数据库接入](foundation/02-database-access.md)

### 3.3 统一资源与状态

- 使用同一模型描述平台、集群、节点、数据库、Schema、表、字段、Job 和 Pipeline。
- `contains` 提供层级主树，其他关系组成资源图。
- 结构事实与实时运行状态分离。

文档：[统一资源与状态](foundation/03-unified-resource-state.md)

### 3.4 公共类型与合同

- SDK、REST、CLI、WebUI、Connector、Agent、MCP 和 Skills 共用稳定合同。
- 公共合同只描述已经开发的真实行为，不预先猜测未来字段。

文档：[公共类型与合同](foundation/04-public-types-and-contracts.md)

## 4. 大模块一：AI SQL 生成与执行

### 目的

通过 Agent 自主检索数据库知识、浏览资源、探索数据、生成和执行 SQL，并根据数据库结果继续修正。

### 子模块

1. 层级知识目录、业务知识与 Merkle 版本。
2. 精确、全文、向量、业务词典和图融合检索。
3. ReAct Agent 与六个常驻 AI SQL 工具。
4. 四个内置通用 Skills。
5. 多方言 SQL AST 解析。
6. `read / edit / full` 三档权限和单次批准。
7. SQL 执行、结果分页、错误反馈和 DDL 后知识刷新。
8. Session、用户偏好、可见轨迹、评测与审计。

详细文档：[AI SQL 生成与执行](ai-sql/README.md)

### 效果

- 同时支持中文问题、英文 Schema 和中文数据库对象。
- 不向模型预先灌入整个 Schema，只按需检索和浏览。
- 没有 Embedding 时仍可完整工作。
- Agent 尽可能完成任务，权限系统独立决定是否允许动作。
- 每次结果可以追溯到模型、工具、SQL、批准和知识版本。

## 5. 大模块二：AI 数据库治理与运维

### 目的

以确定性采集和规则为基础，让 AI 只在重要事件、复杂诊断和周期综合评估时介入，控制 Token 成本。

### 子模块

1. 运行状态、日志、指标、配置和变更采集。
2. 慢 SQL、执行计划、锁、长事务、容量和高可用诊断。
3. 元数据、命名、质量、生命周期、权限和血缘治理。
4. 单数据库、集群、数据库群和数仓的分层聚合。
5. 动态采集周期与事件驱动分析。
6. 建议、批准、执行、复查和回滚。

### 效果

- 单机 PostgreSQL 与大型数仓使用同一资源和任务模型。
- 规模扩大主要增加 Connector、MCP 和能力包，不重写 Agent 主流程。
- 常规监控不调用大模型。
- 事实、规则判断和 AI 推断始终分开。

## 6. 大模块三：Agent、扩展与运行控制

### 目的

为 AI SQL 和治理运维提供共用 Agent 运行时、工具、MCP、Skills、权限、Session 和审计。

### 子模块

1. ReAct 循环、Checkpoint、取消和错误恢复。
2. Tool Registry、动态能力包和 Tool Search。
3. 用户 MCP Server 接入与官方 MCP Server。
4. 内置 Skills 与用户导入 Skills。
5. Session 管理和自动提炼的用户偏好。
6. 权限、许可请求、使用量、日志和评测。

### 效果

- 内置工具、MCP 和 Skills 使用同一运行边界。
- Skills 可以限制工作流，但不能扩大权限。
- 大量运维工具按需加载，不持续占用模型上下文。
- 用户可以看到 Agent 做了什么，不暴露隐藏思维链。

## 7. 当前开发顺序

1. 公共基础能力。
2. AI SQL 生成与执行。
3. AI 数据库治理与运维。
4. MCP、用户 Skills 和规模化能力包。
5. 轻量 WebUI 管理能力。

每个模块一次开发完整：工程文档、代码、确定性功能测试、真实依赖集成测试和性能测试同步完成，不使用冒烟测试代替功能验收。
