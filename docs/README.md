# SchemaNaut 用户文档

SchemaNaut 是一个以终端为入口、模型中立、Capability 驱动的通用 Agent。它通过 14 个始终加载的基础 Tool
和 8 类按任务激活的第一方 Capability，组合代码、Git、数据库、浏览器、文档与本地数据分析工作。

模型连接、模型默认值、默认权限模式和组织规则只来自全局 `~/.schemanaut/config.toml`；项目设置只保存
项目 MCP 声明。Capability 复用用户在产品外管理的 CLI、文件、环境变量、服务和登录态，不增加自己的配置层。

## 开始使用

- [产品概览](product/overview.md)：适用场景、核心优势和产品边界。
- [终端指南（中文）](guides/terminal.zh-CN.md)：命令、模型、Session、Skills 和 MCP。
- [Terminal guide (English)](guides/terminal.md)：英文操作参考。
- [Capability 指南（中文）](guides/capabilities.zh-CN.md)：能力目录、外部条件和重试方式。
- [Capabilities guide (English)](guides/capabilities.md)：英文能力参考。
- [诊断与沙盒指南（中文）](guides/diagnostics-and-sandbox.zh-CN.md)：权限、隔离和诊断。
- [Diagnostics and sandbox guide (English)](guides/diagnostics-and-sandbox.md)：英文边界参考。
- [路线图](product/roadmap.md)：已经交付和后续方向。
- [Benchmark 合同](benchmarks/README.md)：未来横向比较的任务、指标和报告规则。
- [安全策略](../SECURITY.md)：凭据、外部工具、工作区与本地状态的责任边界。

## 贡献与内部资料

准备修改代码时，从[开发者文档入口](engineering/README.md)进入。架构合同、代码地图、验证记录和实施计划
属于内部工程资料，不是用户操作手册，也不构成公共 SDK 或 API。
