# BetaV0.1.1 MCP Market 安装抽象

## 变更

- 新增 MCP Market provider 抽象。
- 新增默认静态 MCP catalog。
- 新增 market search / install typed IPC。
- 新增 desktop MCP Market 安装服务。
- 安装流程复用现有 MCP 配置、secret 和启动能力。

## 验证

- core-tools、shared、desktop 类型检查通过。
- MCP market core 测试通过。
- desktop MCP market/service 测试通过。

## 发布备注

该变更为插件市场和第三方 MCP 安装流程提供后端基础。当前没有接入真实网络市场，后续可按 provider adapter 方式接入 Smithery、mcp.so 或企业私有 MCP registry。
