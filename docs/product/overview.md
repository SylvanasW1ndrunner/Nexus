# 产品概览

SchemaNaut 是一个以终端为中心的通用 Agent 产品。它不提供 SDK、HTTP API、Server 或 WebUI。

## 授权

全局 ~/.schemanaut/config.toml 是唯一的权限来源，包含 default、auto、full-access 三档和组织规则。
default 对互联网访问和工作区外编辑要求批准；auto 只对静态声明的高风险动作及组织规则要求批准；
full-access 不会自动拦截动作等待批准。项目、Skill、MCP 和 Capability 都不能覆盖它。

## 配置和能力

全局 config.toml 还保存模型连接和模型默认值；项目 settings.json 只保存项目 MCP 声明。首批
Capability 正在本轮开发中，使用用户已在产品外准备的 CLI、文件、环境、登录状态或服务，不新增
SchemaNaut 内的 Capability 配置。

## 责任边界

SchemaNaut 不识别敏感信息，不脱敏或拦截类似凭据的内容和参数，不判断第三方工具是否可信，也不保证
外部输出安全。用户负责输入、外部工具和模型 Endpoint 配置、日志、Journal、Artifact 及第三方输出
的敏感性。不要将真实凭据提交到 Git。

详见[终端指南](../guides/terminal.zh-CN.md)、[Capability 指南](../guides/capabilities.zh-CN.md)
和[诊断与沙盒指南](../guides/diagnostics-and-sandbox.zh-CN.md)。
