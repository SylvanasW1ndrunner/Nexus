# 代码地图与依赖方向

Nexus 的主线是通用 Agent。底层合同包不依赖接入层；私有 Agent Host 负责组合，终端是用户入口。

    shared contracts
      ├─ core-llm / core-usage / core-skills / core-resource / core-db / core-rag
      ├─ core-agent
      ├─ core-tools
      └─ database-capability 和 first-party-capabilities
                         ↓
                    agent-host
                         ↓
                      terminal

## 强制边界

- 终端通过 bundled Host 创建产品 Runtime，不建立第二个 Agent 循环。
- Capability 注册无外部副作用；命令使用 Host-owned argv Port。
- config.toml 是模型默认值、全局权限和企业执行规则的唯一来源；项目设置只保存 MCP 声明。
- Tool 按操作静态声明权限事实。运行时不扫描内容判断 Secret、凭据或第三方可信度。
- stdout/stderr、Provider 错误和外部输出遵守普通大小、取消和生命周期约束；用户负责其敏感性。
