# Tools、结果与产物

## 1. 目的

以一个统一 Tool Registry 承载内置工具、数据库工具、工作区工具、MCP 工具和子 Agent 工具，并通过动态发现与结果投影控制上下文。

## 2. 工具类别

| 类别     | 能力                                    |
| -------- | --------------------------------------- |
| 工作状态 | 创建、读取、更新任务                    |
| 交互     | 请求用户补充和单次批准                  |
| 能力发现 | 搜索 Tool、加载 Tool Schema、加载 Skill |
| 工作区   | 列目录、搜索、读取、写入和局部编辑文件  |
| 终端     | 宿主显式启用后执行有界命令              |
| 网络     | Web Search 与 Web Fetch 适配器          |
| 数据库   | 资源、知识、SQL、EXPLAIN 和结果         |
| 编排     | 创建、补充、等待和停止子 Agent          |

Tool Registry 只提供统一描述、权限、Schema、执行函数和来源元数据。来源协议留在适配器内部。

## 3. 动态发现与调度

- 少量编排工具和高频数据库工具可常驻。
- 大量 MCP、项目和未来能力只先暴露名称、描述与来源。
- Agent 通过 Tool Search 加载完整输入 Schema。
- `resource_list` 未指定 scope 且指定 kinds 时在当前知识目录全局按类型查找；指定 scope 时只浏览该节点的直接子级。同名平台/集群使用可读的类型限定引用，不暴露内部节点 ID。
- 只读且相互独立的调用可以并行；写入和有顺序依赖的调用串行。
- 调度统一处理权限、超时、取消、输出上限、健康和审计。

文件工具默认启用，`shell_run` 默认不注册。只有可信宿主设置 `enableShellTool: true` 后才开放，并且仍要求 `full` 模式。其工作目录受 Project 限制、环境变量采用白名单，但子进程仍继承宿主操作系统权限，不是系统沙箱。

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

Agent 可以在打开的项目范围内生成和修改普通文件。复杂 SQL 优先保存到 `sql/`，报告和导出进入用户指定目录或 `artifacts/`。

SDK 使用通用产物引用报告路径、媒体类型、大小和来源，不限制具体文件格式。用户可以继续读取和修改同一脚本。

## 6. 用户返回边界

Tool 的内部结果信封分别产生模型临时投影、持久摘要和完成证据。用户轨迹只显示有用的 SQL、批准、结果状态和产物，不显示 Tool Call ID、动作签名、检索分数、知识 Hash 或缓存 ID。

工程入口：

- Tool Registry：`packages/core-agent/src/tool-registry.ts`
- 通用工具：`packages/core-tools/src/agent-runtime-tools.ts`
- 工作区工具：`packages/core-tools/src/workspace-tools.ts`
- AI SQL 工具：`packages/core-tools/src/ai-sql-tools.ts`
- 结果存储：`packages/core-tools/src/ai-sql-tools.ts`
- 结果投影信封：`packages/core-agent/src/tool-result.ts`
- 完成验证：`packages/core-agent/src/completion-verifier.ts`
