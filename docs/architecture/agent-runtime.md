# Agent Runtime、Journal 与 Session 合同

本文描述内部稳定合同，而非公共 SDK。

AgentRuntime 协调模型、项目设置、Tool、Skill、MCP、Capability 和持久化依赖。Run、Turn 和 Tool
Invocation 是核心执行单位；Journal 是可恢复事实来源。

## 授权和结果

Runtime 的唯一授权机制是全局 default、auto、full-access 模式与企业规则。Tool 根据静态声明的
操作事实进入该机制；Runtime 不从用户输入、命令参数或第三方输出推断敏感性、凭据或可信度。

Tool 结果、命令 stdout/stderr、Provider 错误和本地 retention 仅受通用大小、取消和生命周期限制，
可包含原始外部内容。用户负责输入、外部配置、模型 Endpoint、日志、Journal、Artifact 和第三方输出
的敏感性。

## 进程和沙盒

require_sandbox 若配置，是全局企业执行规则。Host 无法提供必需沙盒时返回 unavailable；策略允许用户
决定未沙盒执行时返回 ask-unsandboxed。原生 Windows 无强隔离时，自然退出可报告退出结果，而
containment 和完整子孙进程终止可能为 unverified 或 unknown。
