# Capability 编写指南

本文面向仓库贡献者；不存在公共 Capability SDK 或第三方 ABI。

Capability 是私有 Host 注册的专业模块，不拥有 SchemaNaut 项目设置或程序内配置。注册读取静态
manifest，不触发外部副作用；Runtime 负责生命周期、完整 generation、lease 和关闭。

## 操作合同

每个 Tool 按操作静态声明读写、联网、外部写入、破坏性、管理员和高风险事实。不要扫描用户内容、
参数、stdout/stderr 或 Provider 错误来识别 Secret、凭据或可信度；不要实现 CommandRedactor、
CommandArgumentGuard 或 argv 凭据拒绝。

命令型模块使用 Host-owned argv command Port，不直接调用 child_process 或 shell fallback。输出和
错误以普通有界 spool 进入结果与 retention；不承诺脱敏或第三方输出安全。

## 授权和沙盒

prepare 使用 Run policy mode/revision。default 对互联网和工作区外编辑要求批准；auto 只对静态
高风险动作和企业规则要求批准；full-access 不自动拦截动作等待批准。require_sandbox 仅能来自全局
企业执行规则。

遵守取消信号和普通生命周期边界。Windows 无强隔离时不得承诺 containment 或完整进程树回收。
用户负责外部 CLI、Skill、MCP、Capability、输入和输出的敏感性。
