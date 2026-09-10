# 基础 Tool 设计

本文定义通用 Agent 的内部基础 Tool 边界。Tool 通过统一 Runtime 执行，并按每次操作静态声明工作区写入、
联网、外部写入、破坏性、管理员或高风险事实。

## 授权

唯一的产品授权机制是全局 config.toml 中的 default、auto、full-access 和企业规则。default 对互联网
访问和工作区外编辑要求批准；auto 只对静态高风险动作和企业规则要求批准；full-access 不自动拦截
动作等待批准。项目、Skill、MCP 和 Capability 都不能提高权限。require_sandbox 若存在，只是全局
企业执行规则。

## 内容与输出边界

Runtime 不识别敏感信息、不脱敏、不拦截类似凭据的命令参数，也不判断第三方 CLI、Skill、MCP 或
Capability 是否可信。Tool 结果、stdout/stderr、Provider 错误、Journal、Artifact 和 retention
使用普通大小、取消和生命周期约束，可保留原始内容。用户负责输入、端点、外部工具和输出的敏感性。

## 执行

所有 Tool 经过 prepare、authorize、schedule、execute、observe。命令型 Tool 使用 Host-owned argv
Port；不使用 shell fallback。Capability 按任务动态发现，但与基础 Tool 共用同一授权和执行主干。
