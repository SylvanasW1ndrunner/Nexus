# SchemaNaut 路线图

这份路线图说明面向用户的方向，而不是安装承诺、公共 API 承诺或某个内部组件的状态。

## 产品原则

- schemanaut 继续是受支持的用户入口。
- 模型连接、默认生成参数和组织权限只存在于全局 config.toml；项目不保存密钥或权限覆盖。
- 可选 Capability 使用用户已经在产品外准备好的条件，不增加专属项目配置。
- 无论外部依赖是否齐备，缺少某项可选能力都不应阻止通用 Agent、Skill 或 MCP 的基础工作流。
- 权限、许可、取消、恢复和结果说明必须让用户能够理解一个动作会影响什么。

## 近期方向

### 外部环境与恢复

改进模型、MCP 与可选能力的诊断：指出缺少的 CLI、文件、登录状态、服务或安全引用；用户在产品外修复后，
可以重新发现或重试，而不必重建项目或 Session。

### 首批可选能力

首批开发中的范围覆盖 Git、Database、Forge、Containers、Browser Automation、Language Intelligence、
Documents 以及 Data & Notebook。每一项整合后都按任务使用，并在依赖不可用时提供安全、可行动的说明。
它们不会把数据库或任何单一领域变成启动前提或产品主线。

### 权限、隔离与可解释性

继续完善三档全局权限、组织规则和许可说明。产品会准确说明一个动作是否可以在当前主机隔离运行；
不会把未隔离的动作描述为已隔离。

### 长期方向

在上述交互边界稳定后，再评估本地发行体验。此方向不意味着 npm 发布，也不意味着提供 SDK、
HTTP 服务或 WebUI。

## 如何跟进

请以[终端指南](../guides/terminal.zh-CN.md)、[Capability 指南](../guides/capabilities.zh-CN.md)
和[诊断与沙盒指南](../guides/diagnostics-and-sandbox.zh-CN.md)了解当前可用的用户流程。
