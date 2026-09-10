# 基础 Tool 实现说明

本页记录当前工程边界，而非用户安全承诺。

- 权限模式和企业规则只来自全局 config.toml；项目设置只保存 MCP 声明。
- Tool 按操作静态声明权限事实，统一经过 Runtime 调用主干。
- Runtime 不扫描用户内容、命令参数或外部输出判断 Secret、凭据或可信度。
- stdout/stderr、Provider 错误、Journal、Artifact 和 retention 使用普通大小、取消和生命周期约束；
  用户负责这些内容的敏感性。
- 命令型 Capability 使用 Host-owned argv Port；基础 process_exec 保留用户 shell command 合同。
  require_sandbox 若配置，属于全局企业执行规则。

不要将真实凭据提交到 Git 是仓库卫生要求，不是产品脱敏或输出安全治理。
