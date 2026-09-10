# 代码地图与依赖方向

Nexus 的产品主线是通用 Agent。底层合同包不依赖接入层；私有 Agent Host 负责组合，终端是当前用户入口。
专业 Capability 只能通过 Host 服务接入，不能反向导入 Host 或终端。

## 依赖方向

    shared contracts
      ├─ core-llm / core-usage / core-skills / core-resource / core-db / core-rag
      ├─ core-agent  ← Journal、Kernel、Tool 执行协议
      ├─ core-tools  ← 工作区、进程、MCP 与 sandbox Port
      └─ database-capability 和 first-party-capabilities
                         ↓
                    agent-host
                         ↓
                      terminal

## 主要入口

| 范围 | 职责 |
| --- | --- |
| packages/core-agent | Journal、Kernel、权限、Tool 调度与统一调用合同。 |
| packages/core-tools | 基础 Tool、MCP、ProcessRuntime、SandboxExecutor 和受控命令 Port。 |
| packages/core-llm | 模型连接、协议、目录与生成参数。 |
| packages/core-skills | Skill 解析、注册与搜索。 |
| packages/database-capability | Database 专业模块及其外部环境 Provider。 |
| packages/first-party-capabilities | Git、Forge、Containers、Browser、Language、Documents、Data & Notebook 模块。 |
| packages/agent-host | 私有组合、全局配置、项目 MCP 设置与 bundled Runtime。 |
| apps/terminal | 终端命令、交互、呈现和用户批准输入。 |

## 强制边界

- 终端不得建立第二个 Agent 循环，且只通过 bundled Host 创建产品 Runtime。
- AgentRuntime 的直接构造保留为无默认专业能力的内部组合和测试入口。
- Capability 注册无外部副作用；所有命令使用 Host-owned argv Port。
- 全局 config.toml 是模型、默认参数和企业权限的唯一来源；项目设置只保存 MCP 声明。
- Tool 的权限、批准、取消、恢复、结果保留和 provenance 只存在于统一调用主干。
