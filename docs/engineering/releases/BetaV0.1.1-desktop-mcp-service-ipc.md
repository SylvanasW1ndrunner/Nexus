# BetaV0.1.1 desktop MCP 服务与 IPC

## 变更

- 新增 desktop MCP 后端服务。
- 新增 typed MCP IPC：list、upsert、remove、start、stop、startAutoStart、restartDue、health。
- MCP env secret 通过本地凭据存储保存，配置和 IPC 不返回明文。
- 启动 MCP server 后会把工具注册进 Agent `ToolRegistry`，停止或删除后移除。
- 应用启动时会执行 autoStart MCP server 启动流程。

## 验证

- shared 类型检查通过。
- desktop 项目引用类型检查通过。
- desktop MCP service 测试通过。

## 发布备注

该变更补齐 MCP 的无 UI 后端入口。后续 UI 重建时，可以直接调用 `mcp:*` IPC 实现 MCP 设置页和插件市场安装流程。
