# Capability 外部配置与全局权限设计

**日期：** 2026-09-08

**状态：** 已确认，进入实现

## 1. 目标

本轮只解决已经确认的用户体验边界：Capability 不再要求用户在 SchemaNaut 项目设置中重复配置；模型连接也不再属于项目；Agent 权限改为通用的三档模式，并且只允许全局策略约束。

基础固定 Tool / 基础 Capability 的清单、加载优化和 Claude Code 对照研究是下一阶段议题，不纳入本轮实现。

## 2. Capability 的产品定义

Capability 是插件式的增强工具集。它可以贡献 Tool、Skill、上下文、验证器、服务和调用钩子，以更少的模型 token 和试错成本完成特定任务。Capability Control Plane 继续负责注册、探测、不可变 generation、发布、lease、排空、回滚和关闭，但它是内部运行机制，不是用户配置面或用户入口。

用户和模型只接触 Capability 贡献的 Tool 及其结果。数据库 Capability 只是一个普通可选工具集，不是产品中心，也不是特殊配置系统。

## 3. Capability 无内置配置

删除 Capability manifest、生命周期 API、项目设置 schema 和 Host 协调逻辑中的模块配置概念：

- manifest 不再声明配置 schema；
- `activate` 和 `refresh` 不再接收配置对象；
- `.schemanaut/settings.json` 不再包含 `modules`；
- Capability 可用性只能来自运行时对外部环境的探测，不能来自 SchemaNaut 内部的“已配置”状态；
- Capability 失败时返回面向 Agent 的可行动原因，例如缺失命令、凭据、登录状态、文件或外部服务；不得要求用户填写 SchemaNaut Capability JSON；
- 外部环境可能由用户自行通过 CLI、环境变量或任意文件改变，也可能由 Agent 依据自然语言使用通用 Tool 或 Capability 可选帮助 Tool 完成改变；
- 一次失败不能永久缓存。显式发现、重试或运行时刷新必须重新执行 `probe`，并在条件满足后允许 `activate`；已发布 generation 在替换失败时保持可用。

Capability 可以提供帮助或诊断 Tool，但这只是工具贡献，不构成统一配置协议、配置 UI 或控制平面入口。

## 4. 设置作用域

### 4.1 项目设置

`<project>/.schemanaut/settings.json` 只保存真正与项目共同演进的设置。本轮保留 MCP Server 声明；删除模型连接、模型默认参数和 Capability 模块配置。Session 继续保存实际选择的模型绑定。

项目设置不得覆盖 Agent 权限模式或企业权限规则。

### 4.2 全局设置

唯一的全局配置文件为 `~/.schemanaut/config.toml`。它承载：

- 模型连接与全局生成默认值；
- 默认 Agent 权限模式；
- 企业级 `allow` / `ask` / `deny` 规则。

不存在项目级 `config.toml`，也不从项目目录向上搜索同名文件。这样项目内容不能静默放宽企业策略。

模型密钥不得以明文值写入项目或全局配置。全局模型连接只保存环境变量名或后续安全存储引用；运行时在本机解析后注入连接，任何摘要、诊断、Journal 和模型上下文都只显示引用或脱敏状态。

建议的最小形态如下；最终字段以实现导出的 schema/type 为准：

```toml
version = 1

[agent]
permission_mode = "default"

[[models.connections]]
name = "work"
endpoint = "https://example.invalid/v1"
api_key_env = "MODEL_API_KEY"

[models.parameters]
temperature = 0.2

[[permissions.rules]]
id = "block-production-delete"
decision = "deny"
tools = ["sql_execute"]
actions = ["database-schema"]
hosts = ["prod-db.example.com"]
```

## 5. 三档 Agent 权限

用户可为新 Run 选择：

- `default`：工作区内普通读取和编辑自动执行；写入工作区外、访问网络及风险操作请求批准；
- `auto`：除危险、破坏性、凭据或管理员级操作外自动执行；
- `full-access`：内置策略不发起交互批准，但输入校验、作用域解析、审计和非幂等恢复约束仍然存在。

Tool 必须提供足以做决定的结构化事实，而不是继续用 `read/edit/full` 等级比较：动作类别、效果、危险等级，以及运行时解析出的路径和网络主机等资源。

全局规则按 Tool、动作、路径和主机选择器匹配。所有匹配规则采用最严格结果：`deny` 高于 `ask`，`ask` 高于 `allow`。显式全局规则覆盖模式的内置决定；因此企业 `ask/deny` 在 `full-access` 下仍可生效。没有匹配规则时才使用三档模式的内置行为。

Run 保留创建时选择的权限模式，但每次 Tool 调用都应用当前全局企业规则。这样规则收紧后，已经持久化或恢复的 Run 也不能继续绕过新的 `ask/deny`。

数据库内部对 SQL 只读、写入和 DDL/管理操作的分类仍可保留，但必须使用数据库专用命名，不能继续冒充 Agent 的权限模式。数据库 Tool 最终把 SQL 分类转换为统一动作、风险和资源事实，再进入同一 Tool Invocation 权限管线。

## 6. Skills 与 MCP

本轮不增加来源可信度评分、签名体系或安全评分 UI。Skill 是指令/资源，MCP 是 Tool 来源；二者与内置 Tool、Capability Tool 一样经过同一个注册、调用、权限、批准、审计、取消和恢复边界，不得拥有旁路。

## 7. 运行时数据流

```text
全局 config.toml ──► 模型连接 / 默认权限 / 企业规则
                         │
项目 settings.json ──► MCP 等项目作用域声明
                         │
外部 CLI / 文件 / 环境 ─► Capability probe ─► generation 发布
                         │
用户自然语言 ─► Agent ─► Tool Invocation ─► allow / ask / deny ─► Tool 结果
```

Control Plane 和 Capability 配置细节不向用户投影。用户可见的是 Tool 是否可用、失败缺少什么、是否需要批准，以及外部条件改变后能否成功重试。

## 8. 兼容性与迁移原则

本轮不为错误架构保留兼容层：

- 旧项目 `llm` 和 `modules` 字段应被严格校验拒绝，并给出迁移到全局配置或删除字段的诊断；
- 旧 `/mode read|edit|full` 不保留别名；
- 内部事件或耐久状态若需要读取历史数据，只在反序列化/upcast 边界做一次性语义迁移，新的公共类型和写入数据只使用新模式；
- SQL 的历史权限字段按数据库语义重命名，不与 Agent 模式共享类型。

## 9. 验收标准

- Capability API 和项目设置中不存在模块配置声明、值或 revision；外部前置条件改变后可重新探测并激活；
- 项目设置不再接受模型或 Capability 配置；模型从唯一全局 TOML 加载，Session 只持久保存选择；
- 配置和诊断中没有明文模型密钥，缺失环境引用时提供可行动错误；
- Agent 全链路只出现 `default`、`auto`、`full-access`，并符合三档内置行为；
- 全局规则能按 Tool、动作、路径、主机执行最严格的 `allow/ask/deny`，且项目不能覆盖；
- Skill、MCP、内置 Tool、Capability Tool 继续走同一 Invocation Runtime；
- 数据库内部分类与 Agent 权限类型解耦；
- 文档、终端帮助、类型、事件、测试和示例一致；
- 最终统一运行构建、类型检查、测试和架构关键词扫描，并记录真实失败，不以未运行的外部环境验收冒充通过。
