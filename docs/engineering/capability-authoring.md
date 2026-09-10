# Capability 编写指南

本文面向仓库贡献者。不存在公共 Capability SDK 或第三方 ABI。

## 模块边界

Capability 是由私有 Host 注册的专业模块，不是第二个 Agent 循环。它不拥有 SchemaNaut 项目设置、
程序内配置或密钥存储。可用性只来自安全、有界的外部 probe；缺失条件必须返回可行动、脱敏的诊断。

注册读取静态 manifest，不能触发网络、进程或数据库副作用。Runtime 负责激活、刷新、发布、lease
和关闭。贡献只能来自一个完整、不可变 generation；失败的替代 generation 不得破坏旧 generation。

## 贡献与执行

Tool、Skill source、context provider、delivery verifier、service 和 state reference 都必须通过
Runtime 的贡献合同。Tool 不得绕过 prepare、authorize、schedule、execute、observe，也不得自行
写 Journal、处理许可或建立另一条执行路径。

命令型模块只能使用 Host 提供的 argv command Port。禁止直接导入 node:child_process、拼接 shell
命令或使用 shell fallback。PATH probe 返回 launch descriptor；Windows npm .cmd 必须安全解析为
node 与入口脚本。所有输出、错误、路径和外部响应均应有大小边界并脱敏。

## 风险、取消与沙盒

每个 Tool 独立声明读写、网络、外部写入、破坏性、凭据、管理员和未知风险事实。不得把 cargo check、
format、Playwright 或 notebook 等有副作用的 backend 误写为只读。prepare 使用 Run policy mode 和
revision 快照；execute 必须复核该快照。

遵守 invocation、lifecycle 和 teardown 的取消信号。Windows 无强隔离时，不得承诺 containment 或
完整进程树回收；对无法证明已停止的 descendant 使用 unknown。强隔离不可用时返回 unavailable，
可由用户决定的未隔离执行返回 ask-unsandboxed。

## 验证

每个模块至少覆盖静态注册无副作用、available/degraded/unavailable probe、刷新失败保留旧 generation、
取消、风险分类、结果上限、脱敏和外部状态修复后的重试。完整策略见[验证策略](verification.md)。
