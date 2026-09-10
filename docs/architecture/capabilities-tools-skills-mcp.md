# Capability、Tool、Skill 与 MCP 合同

本文是开发者文档，定义稳定合同；用户操作请参阅[Capability 指南](../guides/capabilities.zh-CN.md)。

## 统一动作边界

Tool 是唯一的可执行动作合同。Skill 是受控加载的指令与资源；MCP Tool 会被适配到同一合同；
子 Agent 也通过 Runtime Tool 调度。所有来源都必须走 prepare、authorize、schedule、execute、
observe 主干，并共享输入校验、全局权限、批准、审计、取消、恢复、结果保留和 provenance。

Capability 是由 Host 注册、按任务发现和激活的专业 Tool 集。它不是第二个 Agent 循环，也不是项目
或程序内配置对象。注册必须无外部副作用；外部条件在探测时观察，任务需要专业能力时再延迟激活。

## Capability 生命周期

Host 注册静态 manifest。内部 Capability Control Plane 负责探测、激活、刷新、发布和关闭。
一个 Turn 捕获完整、不可变的贡献快照并持有 lease；刷新只能发布完整的新 generation，旧 generation
在已有 lease 排空后才可关闭。因此同一 Turn 不得混用前后两组 Tool、Skill、上下文或服务贡献。

探测结果为 available、degraded 或 unavailable 时，都必须有有界、脱敏且可行动的说明。探测只能
依赖外部条件，不能读取 SchemaNaut 专属 Capability 配置。外部 CLI、文件、登录或服务改变后，可
再次探测；父进程 PATH 或环境改变则要求重启 Host。

## 配置和执行边界

全局 config.toml 只承载模型连接、默认生成参数和企业权限。项目 settings 只承载 MCP 声明。
Capability、项目、Skill 和 MCP 均不能加入权限覆盖或 Capability 配置。

命令型 Capability 只能使用 Host-owned ProcessRuntime 或 SandboxExecutor 提供的 argv Port，不能
直接调用 node:child_process，也不能使用 shell fallback。PATH 发现必须返回可审计的 launch
descriptor；Windows 的 npm .cmd 入口必须安全解析为 node 和入口脚本。

prepare 必须捕获 Run policy mode 和 revision、执行目标、沙盒要求和资源边界。execute 复核同一
快照后才可运行。逐 Tool 风险必须精确：cargo check、格式化、Playwright 与 notebook 执行不得被
笼统标为只读或仅影响声明路径。

## MCP 边界

MCP 配置是项目范围的外部程序或服务声明。其 Tool 使用统一调用合同，但 MCP 配置本身仍需作为
不可信外部输入审查。终端可以管理 MCP 生命周期，不公开内部 Tool Registry 或 Capability Control
Plane 的可变接口。

## 首批模块范围

首批内置模块为 Git、Database、Forge、Containers、Browser Automation、Language Intelligence、
Documents 和 Data & Notebook。它们平等地作为按需增强，不得把 Database 变成通用 Runtime 的
启动前提或固定基础 Tool。
