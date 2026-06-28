# BetaV0.1.1 增量：Agent 激活工作区工具

## 变更

- 桌面端 Agent 的 workspace 文件工具现在会在执行时读取当前激活 Workspace。
- `registerWorkspaceTools()` 支持异步 `getWorkspaceRoot`，便于接入桌面端持久化项目状态。
- 保留未打开项目时的明确失败边界：`No active workspace.`。

## 测试

- 新增 core-tools 异步 workspace root provider 测试。
- 新增 desktop Agent bootstrap 真实临时工作区读写测试。
- 本切片不新增运行时依赖，不改变打包策略。

## 发布风险

- 当前能力只提供工作区文件读写工具注册，不代表正式前端 UI 已恢复。
- 后续仍需把 workspace Python script 动态工具接入 desktop Agent runtime，并补充项目切换后的审计和权限记录。
