# Skills、MCP 与子 Agent

## 1. 标准 Markdown Skills

Skill 使用 Agent Skills 兼容目录：

```text
<skill-name>/
├─ SKILL.md
├─ references/
├─ scripts/
└─ assets/
```

`SKILL.md` 使用 YAML frontmatter 与 Markdown 正文。标准字段保持生态语义，SchemaNaut 扩展放入 `metadata.schemanaut`。

作用域：

1. System：随安装包发布，只读。
2. User：跨项目个人 Skills。
3. Project：`.schemanaut/skills`，项目所有 Session 共用。
4. Session：按 `sessionId` 私有，随 Session 写入 SQLite，不写入项目 Skill 目录。

System、User 与 Project 由一个可刷新公共目录提供；每个 Session 在该目录上建立独立内存覆盖层。同名解析只在当前 Session 内遵循 `session > project > user > system`，任何 Session Overlay 都不能写回公共目录或进入其他 Session。Runtime 构造参数 `sessionSkills` 是“新 Session 默认模板”：创建时复制，之后由 Session 自己持久化；恢复 Session 不重新套用后来变更的默认模板。SDK 可在新建时用 `runAgent({ sessionSkills })` 覆盖默认模板，但恢复时不得静默替换。

运行时最初只加载名称、描述、作用域和路径；正文、引用和脚本在 Skill 被显式或隐式选择后加载。模型侧只有统一 `skill` 入口负责搜索、加载和读取 bundle resource；旧的拆分工具保持隐藏兼容，不能进入工具搜索。CLI 支持 `/skills`、`/<skill-name> [args]`，并可提供 `$skill-name` 兼容输入。

Skills 指导工作流和工具组合，不能提高 `read / edit / full` 权限。数据库内置 Skills 只在数据库连接和相应能力可用时进入目录，避免无数据库项目被 SQL 工作流污染。硬安全和一致性规则继续由代码执行。

## 2. 标准 MCP Client

MCP 连接层使用官方 TypeScript SDK，不手写 JSON-RPC。

必须支持：

- 官方生命周期和协议版本协商。
- stdio 与 Streamable HTTP；legacy SSE 只作为官方兼容回退。
- Tools、Resources 和 Prompts。
- 分页、能力声明和列表变化通知。
- 远程认证、Secret 引用、超时、取消、健康和重启。
- MCP 富内容与结构化结果保真。

MCP 原始类型不能进入公共合同。适配器把 Tool 映射为统一描述、执行 Runtime 和 `AgentToolResultEnvelope`，同时在 `protocolMetadata` 中保留 Server、协议、原始名称、Annotations、Task 能力和输出 Schema 等来源语义。未实现的 Sampling、Elicitation 等客户端能力不得虚假声明。

MCP 配置默认不自动启动。宿主应先审核 Server，再显式启动；`autoStartMcp` 只用于可信环境。远程 Server 必须使用 HTTPS（本机回环地址除外），URL、参数、Header 和环境变量不得内嵌凭据，统一使用 Secret 引用。

MCP Server 声明的 `readOnlyHint` 只是提示，不能降低本地权限和风险等级；外部 MCP Tool 至少按 `edit` 处理，危险名称或提示提升为 `full`。REST 默认禁止创建或启动进程型 stdio MCP，必须由可信宿主显式开启。

## 3. 子 Agent

子 Agent 默认使用与主 Agent 相同的自适应循环和普通能力，继承项目、公共 Skill 目录、父 Session Skill 的独立副本、Tool Registry、MCP 和权限模式。父 Run 的 `allowedTools` 继续约束子 Agent，子 Agent 不能通过委派扩大工具边界；Pinned Tools 也必须在该允许集合内。子 Agent 激活或更新自身状态时不得写回父 Session 或其他 Session。

子 Agent 必须拥有独立上下文、任务状态、取消和用量记录。主 Agent 通过委派任务创建子 Agent，可用 `subagent_message` 补充要求，并通过 list/wait/stop 管理生命周期。子 Agent 返回结论、证据和产物引用，不把完整子会话灌回主上下文。

默认使用新上下文；确实依赖主对话时可以选择有界 Fork。首个版本默认只允许主 Agent 委派一代子 Agent，避免递归扩张；并发、深度和总运行时间都由运行时硬限制。

## 4. 工程与验收

- Skills：`packages/core-skills`
- Skill 模型入口：`packages/core-tools/src/skill-tools.ts`
- MCP：`packages/core-tools/src/mcp-*.ts`
- 子 Agent：`packages/core-agent/src/subagent-pool.ts`
- 子 Agent 工具：`packages/core-tools/src/subagent-tools.ts`
- 统一工具：`packages/core-agent/src/tool-registry.ts`

验收覆盖新 Session、并发 Session、SQLite 恢复、默认模板快照、显式项目校验、同名解析、公共目录动态刷新、渐进加载、损坏 Skill、子 Agent Skill 继承与上下文隔离、MCP 能力协商、通知、崩溃、超时、远程传输、工具动态注册、取消和结果汇总。

## 5. 依赖决策

- MCP 使用 `@modelcontextprotocol/sdk@1.29.x`（MIT）。手写 JSON-RPC 会复制协议协商、传输、分页、通知与取消逻辑，并容易随协议演进漂移，因此不采用。适配器只把稳定的 Tool/Resource/Prompt 投影接入内部 Registry，官方 SDK 类型不进入公共合同。
- Skills Frontmatter 使用 `yaml@2.x`（ISC）。自写 YAML 子集会让用户的标准 `SKILL.md` 在不同 Agent 间出现兼容差异，因此不采用。正文仍按 Markdown 原样保存，只有激活时才加载。
- 两项依赖都是纯 JavaScript/TypeScript，不包含原生二进制，也不在运行时下载组件。安装依赖后，System/Project/User/Session Skills 与 stdio MCP 可离线使用；远程 MCP 是否联网由用户配置决定。
