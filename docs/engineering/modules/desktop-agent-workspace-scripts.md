# desktop：Agent 工作区 Python 脚本工具

## 职责

桌面端负责把 active workspace 中声明为工具的 Python 脚本接入 Agent `ToolRegistry`。具体脚本扫描、参数校验和进程执行仍复用 core 包能力：

- `core-workspace.discoverScriptTools()`
- `core-tools.registerWorkspaceScriptTools()`
- `core-tools.runWorkspacePythonScript()`

## 生命周期

`registerDesktopAgentTools()` 返回 `DesktopAgentToolRegistration`：

- `refreshWorkspaceScriptTools()`：刷新当前 active workspace 的动态脚本工具。
- `registeredWorkspaceScriptToolNames()`：返回当前桌面端登记的动态脚本工具名。

主进程调用时机：

- 应用启动后。
- 创建 workspace 后。
- 打开 workspace 后。
- 更新 workspace 设置后。

## 安全边界

- 刷新前先卸载上一批 `workspace_script:*` 工具，避免旧项目工具继续出现在 Agent policy 中。
- handler 执行前读取当前 active workspace；如果 root 与注册时 root 不一致，直接拒绝执行。
- 脚本仍通过 `WorkspaceCore` 发现，路径必须落在 workspace 内。
- Python 子进程执行不接触数据库凭证或 LLM API key；后续如需注入凭证，必须通过显式权限和 secret adapter。

## Python 配置

桌面端通过 `resolveWorkspacePythonExecution()` 把 workspace Python 配置转换为 `runWorkspacePythonScript()` 可理解的参数：

- `system`：默认使用 `python`，或使用配置的 `pythonPath`。
- `venv`：解析 workspace 内 `.venv` 或指定 venv 路径。
- `conda`：支持 conda env name、conda prefix 或显式 `pythonPath`。
- 默认超时：使用配置中的 `timeoutSeconds`，缺省为 300 秒。

## 测试入口

- `apps/desktop/src/main/agent-tool-bootstrap.test.ts`
- `packages/core-tools/test/workspace-script-tools.test.ts`
- `apps/desktop/src/main/python-environment.test.ts`
