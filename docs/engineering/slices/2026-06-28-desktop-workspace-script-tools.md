# 2026-06-28 切片：桌面端 Agent 动态 Python 脚本工具

## 背景

工作区与 Python 能力已经具备三块基础：

- `core-workspace` 可以扫描 `scripts/` 中带 docstring 标记的 Python 文件。
- `core-tools` 可以把脚本注册成 `workspace_script:*` Agent 工具。
- `runWorkspacePythonScript()` 可以真实启动 Python 子进程、限制输出、支持取消、超时和运行归档。

此前缺口在桌面端装配层：Agent runtime 只注册了数据库、Schema RAG 和基础 workspace 文件工具，没有把当前 active workspace 的脚本动态工具接入 `ToolRegistry`。

## 实现范围

- `apps/desktop/src/main/agent-tool-bootstrap.ts`
  - `registerDesktopAgentTools()` 现在返回 `DesktopAgentToolRegistration`。
  - 新增 `refreshWorkspaceScriptTools()`：读取当前 active workspace，扫描脚本并注册 `workspace_script:*`。
  - 刷新前卸载上一批动态脚本工具，避免项目切换后旧工具泄漏。
  - 工具执行前再次确认 active workspace root 仍然匹配注册时 root，避免 stale handler 访问旧项目目录。
  - 默认 runner 复用 `runWorkspacePythonScript()`，并根据工作区 Python 配置注入解释器、conda/venv 参数和默认超时。
- `apps/desktop/src/main/main.ts`
  - 启动后刷新 active workspace 的脚本工具。
  - 创建、打开、更新 workspace 后刷新脚本工具。
  - 刷新失败只写入主进程日志，不阻塞工作区打开，避免坏脚本让用户无法进入项目。
- `packages/core-tools/src/workspace-script-tools.ts`
  - `getWorkspaceRoot` 支持异步 provider。
  - 注册前校验重复 `workspace_script:*` 名称，避免 registry 出现部分注册状态。
- `apps/desktop/src/main/python-environment.ts`
  - 导出 `resolveWorkspacePythonExecution()`，让 Agent 脚本 runner 复用桌面端已有 Python 配置解析逻辑。

## 开源与依赖判断

本切片不新增第三方依赖。原因：

- Python 子进程执行已由现有 `runWorkspacePythonScript()` 基于 Node `child_process.spawn` 实现，具备打包风险最低的跨平台基础能力。
- 工作区脚本声明使用轻量 docstring 约定，符合产品当前“脚本即工具”的 M5 方向；暂不引入 notebook、MCP server 或外部 task runner。
- 后续如要增加完整沙箱、资源隔离或依赖管理，应单独评估 uv、conda、micromamba、bubblewrap、Windows Job Object 等方案，不应混入本切片。

## 测试覆盖

- core-tools：
  - 异步 active workspace root provider。
  - 重复脚本工具名在注册前失败，且不产生部分注册。
  - 既有真实 Python runner、失败归档、超时、取消、输出截断测试继续保留。
- desktop：
  - refresh 后可以从 active workspace 注册脚本工具。
  - 工具元数据包含 `source: "workspace-script"`、`sourceId` 和 `originalName`。
  - 工具执行会携带 rootPath、relativePath、参数、Python 命令和默认超时。
  - active workspace 变化后，旧脚本工具执行会被拒绝。
  - 刷新新 workspace 后旧工具卸载、新工具注册。

## 当前边界

- 当前只是后端 runtime 接线，不恢复正式前端 UI。
- 动态脚本工具刷新依赖创建、打开、更新工作区事件；后续文件 watcher 可以作为增量能力加入。
- Python 网络隔离、内存限制和依赖安装策略仍未实现，当前只提供进程级超时、取消和输出控制。
