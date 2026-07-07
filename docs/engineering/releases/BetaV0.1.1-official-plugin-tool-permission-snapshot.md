# BetaV0.1.1 官方插件工具权限快照

## 范围

本切片强化官方插件和 Agent 工具白名单边界，重点是为后续插件市场、MCP 工具和 Skill 执行提供统一权限快照。

新增能力：
- 静态官方工具不再只按名称匹配，还会检查 runtime source。
- 动态 MCP / workspace script 工具不能接管官方静态工具名称。
- Agent 工具策略返回 `toolPermissions`，包含插件、贡献项、风险、审批策略、资源范围、网络/进程访问和 secret 类型。
- Headless Agent policy preview 通过 shared IPC 类型暴露同一权限快照。

## 兼容性

- 未改变现有工具名称和 Agent run 参数。
- 未新增 npm 依赖。
- 未修改前端 UI。
- 未启动或安装任何 MCP server。

## 验收重点

- `query_database` 这类官方数据库工具不能被 user MCP 同名工具冒充。
- Skill `allowedTools` 仍只能收窄最终工具集合。
- 权限快照只包含最终允许进入 Agent 的工具。

## 已知限制

- 当前权限快照是本地策略结构，不等同于完整插件签名或沙箱能力。
- 第三方插件包安装、签名校验和市场搜索仍未接入。
- MCP server 真实启动和健康恢复仍由现有 MCP runtime manager 负责，本切片只处理工具授权解释。
