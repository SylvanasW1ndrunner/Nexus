# core-tools Python Runtime 官方工具

## 目标

本模块把产品文档中的三个内置 Python 工具接入 Agent Tool Registry：

- `run_python_script`
- `python_repl`
- `install_python_deps`

它们用于让 Agent 在当前工作区内运行脚本、执行短 Python 代码、安装工作区依赖。当前阶段只实现后端能力，不涉及前端 UI。

## 代码入口

- `packages/core-tools/src/python-runtime-tools.ts`
- `packages/core-tools/src/official-plugin-registry.ts`
- `apps/desktop/src/main/agent-tool-bootstrap.ts`

## 工具合同

### run_python_script

执行当前工作区内的 `.py` 脚本。脚本路径由 `runWorkspacePythonScript()` 校验，只能落在 workspace 内，并复用已有运行归档能力。

输入：

- `path` 或 `relativePath`
- `args`
- `timeoutMs`

输出复用 `WorkspaceScriptRunResult`，包括 stdout、stderr、exitCode、超时/取消状态、运行归档路径和 `.dbagent/history.jsonl` 摘要。

### python_repl

执行短 Python 代码片段，不创建脚本文件。它使用当前工作区作为 cwd，并使用工作区 Python runtime 解析出的解释器。

输入：

- `code`
- `timeoutMs`
- `maxOutputBytes`

输出包括 command、cwd、exitCode、stdout、stderr、elapsedMs、timeout、abort 和截断状态。

### install_python_deps

通过 `python -m pip install --disable-pip-version-check` 安装依赖。默认使用工作区 `requirementsPath`，也允许显式传入 `packages`。

输入：

- `packages`
- `requirementsPath`
- `upgrade`
- `writeRequirements`
- `timeoutMs`
- `maxOutputBytes`

如果传入 packages 且启用 `writeRequirements`，服务会把缺失 package spec 原子写入 requirements 文件，再通过 `pip install -r` 执行安装。

## 权限策略

三个工具全部注册为：

- `dangerLevel: high`
- `readonly: false`
- `source: official`
- `sourceId: official.workspace-python`

执行规则：

- `readonly`：拒绝。
- `ask` / `auto`：必须存在 approval provider 授权上下文。
- `full-auto`：允许执行，但仍受路径、包参数、超时和输出上限约束。

## 桌面装配

`apps/desktop/src/main/agent-tool-bootstrap.ts` 通过 `workspaceProjectStore.loadActive()` 获取当前工作区，再调用 `resolveWorkspacePythonExecution()` 注入：

- `rootPath`
- `requirementsPath`
- `pythonPath`
- `pythonArgs`
- `timeoutMs`

因此 core-tools 不依赖 Electron，也不直接读取桌面配置文件。

## 开源与依赖评估

本切片不新增依赖。

- Python 运行使用 Node 原生 `child_process.spawn`，与现有 workspace script runner 保持一致。
- 依赖安装使用 Python 官方入口 `python -m pip`，避免绑定某个第三方包管理器。
- `uv`、`poetry`、`pip-tools` 后续可作为官方插件或 adapter 接入；当前不把这些工具类型写入稳定 ToolRegistry 合同。
- REPL 只是短代码执行，不是交互式 notebook 或 PTY，不引入 Jupyter/ipykernel。

## 测试

`packages/core-tools/test/python-runtime-tools.test.ts` 覆盖：

- 三个工具注册为 high-risk official tool。
- `run_python_script` 使用真实 Python 执行 workspace 脚本，并写入 history。
- `python_repl` 使用真实 Python 执行短代码并验证输出截断。
- `install_python_deps` 使用真实 `python -m pip` 安装空 requirements 文件。
- pip option 注入在启动进程前被拒绝。
- readonly、未授权、无 active workspace 被拒绝。
- AbortSignal 可取消运行中的 Python snippet。

`apps/desktop/src/main/agent-tool-bootstrap.test.ts` 覆盖桌面 Agent 装配层已经注册三项工具。

## 已知边界

- 当前不做内存限制；只做超时和输出上限。
- 当前不禁用 Python 网络访问；网络策略需要后续 runtime sandbox 或企业策略模块。
- `pip install` 长任务还没有流式进度事件；当前返回最终 stdout/stderr。
- 复杂依赖冲突解释、漏洞检查和 lockfile 生成后续应作为官方插件扩展。
