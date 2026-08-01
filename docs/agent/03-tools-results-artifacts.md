# Tools、结果与产物

## 1. 目的

以一个统一 Tool Registry 承载内置工具、数据库工具、工作区工具、MCP 工具和子 Agent 工具，并通过动态发现与结果投影控制上下文。

## 2. 工具类别

| 类别     | 能力                                    |
| -------- | --------------------------------------- |
| 工作状态 | 创建、读取、更新任务                    |
| 交互     | 请求用户补充和单次批准                  |
| 能力发现 | 搜索 Tool、加载 Tool Schema、加载 Skill |
| 工作区   | 列目录、搜索、读取、写入、局部编辑和原子 Patch |
| 进程     | 前台/后台执行、增量读取、标准输入和进程树终止 |
| 网络     | Web Search 与 Web Fetch 适配器          |
| 数据库   | 资源、知识、SQL、EXPLAIN 和结果         |
| 编排     | 创建、补充、等待和停止子 Agent          |

Tool Registry 将本地目录描述 `AgentToolDescriptor` 与实际 Handler/Runtime 分离。描述包含稳定 ID、扁平模型名、别名、标签、输入/输出 Schema、来源、权限、暴露状态、并发组和完成角色；来源协议与连接句柄留在适配器和 Runtime 内部。

## 3. 动态发现与调度

- 少量编排工具和当前能力包的黄金链路可以常驻；`hidden` 和 `disabled` 工具永远不进入搜索结果或模型 Schema。
- 大量 MCP、项目和未来能力先保存在本地目录。客户端 `tool_search` 使用名称、标题、别名、标签、描述和输入字段进行中英文词法/BM25 风格召回；Provider 原生 deferred tools 仅在明确声明支持时使用。
- `tool_search` 激活命中的完整 Schema；`tool_describe` 读取已发现工具。激活绑定当前 Run、目录 revision 和压缩检查点，新任务、目录变化或检查点变化会使旧激活失效。
- `resource_list` 未指定 scope 且指定 kinds 时在当前知识目录全局按类型查找；指定 scope 时只浏览该节点的直接子级。同名平台/集群使用可读的类型限定引用，不暴露内部节点 ID。
- `ExecutionRouter` 在执行前完成 JSON Schema 校验、可见/允许工具检查、Hook、权限与超时；只读调用批量并行，写入和排他调用按原始顺序形成串行屏障。
- Hook 可补充参数或拒绝动作，但不能绕过三档权限，也不能把已经发生的外部动作伪装为未执行。
- 调度统一处理取消、输出上限、健康、失败分类和审计。

文件读取工具默认启用，修改仍由 `edit/full` 权限控制。`process_exec/poll/write/terminate` 默认不注册，只有可信宿主设置 `enableProcessTools: true` 后才开放；执行和输入/终止要求 `full`，轮询只读取当前 Session 拥有的 Handle。命令工作目录受 Project 限制、环境变量采用白名单，但子进程仍继承宿主操作系统权限，不是系统沙箱。兼容字段 `enableShellTool` 会同时启用进程工具和旧 `shell_run`，新宿主应使用 `enableProcessTools`。

## 4. 数据库计算下推

```text
自然语言
→ Agent 生成 SQL
→ 数据库完成过滤 / 聚合 / Join / Window / 异常检测
→ 最多 1,000 行作为独立交互载荷返回 SDK/API/CLI
→ 默认最多 100 行且受 64 KiB 字节上限约束的临时投影进入 Agent
```

结果投影规则：

- SDK/API/CLI 每次执行最多接收 1,000 行及列、行数、耗时和截断状态。
- Agent 默认最多看到 100 行临时样例，调用时可以主动要求更少；投影同时受字节上限约束，数据形态探索仍应尽量由 SQL 缩小范围。
- Agent 需要更多证据时，生成新的聚合、过滤或分页 SQL。
- 数据库错误必须返回，以便修正 SQL。
- 查询行不写入对话、Session、Agent Run 历史或用户偏好。
- 进程内结果缓存只保存已经有界的交互载荷，同时限制过期时间、条目数和总字节数；关闭 Runtime 或删除 Session 时清理。
- 完整导出必须由显式数据库 Query/导出链路直接流向目标，不经过对话。

第一版不默认把数据库结果搬到 Python、Pandas 或模型中再次统计。

## 5. 文件与产物

Agent 可以在打开的项目范围内生成和修改普通文件。`workspace_patch` 会先验证同一文件内全部精确替换，再原子提交；任一替换不唯一或不存在时，文件保持不变。复杂 SQL 优先保存到 `sql/`，报告和导出进入用户指定目录或 `artifacts/`。

SDK 使用通用产物引用报告路径、媒体类型、大小和来源，不限制具体文件格式。用户可以继续读取和修改同一脚本。

## 6. 用户返回边界

Tool 的内部结果信封分别产生模型临时投影、持久摘要和完成证据。用户轨迹只显示有用的 SQL、批准、结果状态和产物，不显示 Tool Call ID、动作签名、检索分数、知识 Hash 或缓存 ID。

工程入口：

- Tool Registry：`packages/core-agent/src/tool-registry.ts`
- Tool 目录检索：`packages/core-agent/src/tool-search-index.ts`
- Tool 暴露计划：`packages/core-agent/src/tool-exposure-planner.ts`
- 执行调度：`packages/core-agent/src/tool-execution-router.ts`
- 通用工具：`packages/core-tools/src/agent-runtime-tools.ts`
- 工作区工具：`packages/core-tools/src/workspace-tools.ts`
- 进程工具：`packages/core-tools/src/process-tools.ts`
- 进程 Runtime：`packages/core-tools/src/process-runtime.ts`
- AI SQL 工具：`packages/core-tools/src/ai-sql-tools.ts`
- 结果存储：`packages/core-tools/src/ai-sql-tools.ts`
- 结果投影信封：`packages/core-agent/src/tool-result.ts`
- 完成验证：`packages/core-agent/src/completion-verifier.ts`
