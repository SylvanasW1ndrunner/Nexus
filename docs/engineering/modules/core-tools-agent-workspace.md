# core-tools：Agent 工作区工具接线说明

## 模块职责

`@dbagent/core-tools` 负责把后端能力注册为 Agent 可调用工具。工作区文件工具属于官方内置能力 `official.workspace-files` 的运行时工具来源，但 core-tools 本身不持有 Electron 状态，也不读取桌面端配置。

## 当前接口

`registerWorkspaceTools()` 接收：

- `registry`：`core-agent` 的 `ToolRegistry`。
- `workspace`：`core-workspace` 的 `WorkspaceCore`，负责真实文件系统操作和路径边界。
- `getWorkspaceRoot`：同步或异步 active workspace root provider。

`getWorkspaceRoot` 支持异步返回，是为了让桌面端在每次工具执行时读取最新项目状态，而不是在启动或注册时缓存旧路径。

## 工具列表

- `list_workspace_dir`：列出 active workspace 内的相对路径。
- `read_workspace_file`：读取 active workspace 内 UTF-8 文本文件。
- `write_workspace_file`：在 active workspace 内执行原子写入。

## 安全边界

- 没有 active workspace 时，统一抛出 `No active workspace.`。
- 所有路径必须交给 `WorkspaceCore` 解析，不能在工具层自行拼接绝对路径。
- 工具层不接触密钥、数据库凭证或 Electron IPC。
- 工具名称、风险等级和 readonly 元数据必须与 official plugin manifest 保持一致。

## 测试入口

- `packages/core-tools/test/workspace-tools.test.ts`
  - 真实临时工作区写入、读取、列目录。
  - 路径越界拦截。
  - 没有 active workspace 时拒绝访问。
  - 异步 active workspace root provider。
