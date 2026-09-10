# 模型、上下文与项目设置合同

本文是开发者文档；用户配置步骤请参阅[终端指南](../guides/terminal.zh-CN.md)。

## 配置所有权

模型 Endpoint、认证引用、模型连接、默认生成参数和企业权限只来自全局
~/.schemanaut/config.toml。密钥字段只保存环境变量名或安全存储引用；解析后的密钥不得进入
设置快照、项目文件、日志、诊断或模型上下文。

项目 settings.json 只保存项目 MCP 声明。Session 保存模型选择和工作事实，但不保存连接凭据。
Capability 不得向全局或项目设置增加专属配置协议。项目、Skill、MCP 与 Capability 均不能覆盖
全局权限。

## 上下文合同

Runtime 在 Turn 生命周期中编译模型输入：Session 历史、项目指令、系统/项目 Skill、按需 Capability
贡献和有界 Tool 输出使用一个统一上下文合同。长结果必须保留在 Artifact 或结果引用中，不能无界
复制到上下文。

外部配置变更可以触发模型发现或重试。刷新失败不能发布部分视图：上一份完整且已接受的视图继续服务，
直到新视图完整可用。

## 权限快照

每个 Tool prepare 接收当前 Run 的 policy mode 和 revision。该快照是执行合同的一部分，必须用于
风险分类、沙盒要求和随后 execute 的复核；不得在执行中读取可变的项目级权限来源。
