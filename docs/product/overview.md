# 产品概览

## 产品定位

SchemaNaut 是一个以终端为中心的通用 Agent 产品。你使用 schemanaut 在项目或工作区中运行任务、
继续 Session 和 Run、使用 Markdown Skill，并连接项目声明的 MCP Server。它不提供 SDK、
JavaScript API、HTTP API、Server 或 WebUI。

## 你可以期待什么

- **可继续的工作**：任务、Session 与 Run 会保存在项目中；终端中断不会自动抹去已提交的工作记录。
- **外部模型连接**：模型从全局配置的连接中发现；你选择的模型随 Session 保存，而连接和密钥不写入项目。
- **受控操作**：文件、进程、网络、MCP、Skill 和可选 Capability 的动作会按全局权限策略处理，并在需要时请求许可。
- **可修复的诊断**：模型、MCP 或可选能力的外部条件不满足时，Agent 会说明缺什么、应在哪里修复以及何时重试。

## 配置与数据边界

~/.schemanaut/config.toml 只保存模型连接、默认生成参数和组织范围的权限规则。密钥只能使用
环境变量名或安全存储引用，不能写成明文。项目 .schemanaut/settings.json 只保存项目 MCP 声明；
项目、Skill、MCP 和 Capability 都不能覆盖全局权限。

Capability 是按任务发现的可选工具集，不是 SchemaNaut 内的项目设置或程序设置。首批能力处于本轮
开发范围，依赖你已经在产品外准备好的 CLI、文件、环境变量、登录状态或服务。能力被整合后，你可以
用自然语言请 Agent 协助完成某个外部步骤；环境修复后再重新发现或重试。详见
[Capability 指南](../guides/capabilities.zh-CN.md)。

## 权限与安全

全局权限档位为 default、auto 和 full-access。它们决定何时需要许可；组织规则可以要求更严格的
处理。请把许可提示当作审阅点，尤其是涉及网络、外部写入、凭据、进程或破坏性操作时。实际隔离能力
取决于当前主机；详见[诊断与沙盒指南](../guides/diagnostics-and-sandbox.zh-CN.md)。

## 适用场景

1. 在代码或运营工作区中，请 Agent 分析、规划并在允许时执行受控操作。
2. 在不把模型连接、密钥或组织权限写入项目的前提下，继续之前的工作。
3. 使用项目 MCP、Skills 和外部就绪的可选能力；依赖缺失时取得可行动的修复与重试建议。

MCP Server、外部工具和工作区内容仍是本地信任边界。用于敏感项目之前，请阅读
[SECURITY.md](../../SECURITY.md)。
