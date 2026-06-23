# BetaV0.1.1 Workspace Python Runner

## 范围

本切片为 `packages/core-tools` 增加真实 Python 子进程 runner，用于工作空间脚本工具和后续 Python 执行能力。不涉及前端 UI。

## 用户场景

数据工程师让 Agent 运行工作空间脚本时，脚本可能成功、报错、卡住、输出巨大日志，或者被用户取消。后端必须在没有最终 UI 的情况下先保证：

- 脚本只能从工作空间内执行。
- 参数不通过 shell 拼接。
- stdout/stderr 可被 Agent 读取，但不会无限膨胀。
- 超时和取消会终止子进程。
- 脚本失败时保留 stderr 尾部，便于 Agent 修复。

## 实现

- 新增 `runWorkspacePythonScript()`：
  - 使用 Node 原生 `child_process.spawn`。
  - 支持 `pythonPath`、`env`、`timeoutMs`、`AbortSignal`、`outputLimitBytes`。
  - 只执行工作空间内 `.py` 文件。
  - 以 JSON 参数启动脚本，不拼接 shell 命令。
- 新增 `WorkspaceScriptExecutionError`：
  - 非零退出、超时、取消都会抛出该错误。
  - 错误对象携带 `WorkspaceScriptRunResult`，包含 stdout/stderr、退出码、耗时、截断标记、超时/取消状态。
- `registerWorkspaceScriptTools()` 现在会把 Agent tool context 的 `signal` 传给 runner。

## 开源与依赖评估

本切片未引入新依赖。原因：

- 当前需求是普通子进程执行、超时、取消和输出控制，Node 原生能力足够。
- Python runner/pty 类库主要价值在交互式终端和 REPL，本切片是非交互脚本执行。
- 新增原生或伪终端依赖会增加 Windows/Linux 打包与离线安装风险。

后续如果实现交互式 Python REPL、终端仿真或更强资源隔离，应重新评估 `node-pty`、平台级 sandbox、容器或 job object/cgroup 方案。

## 测试

`packages/core-tools/test/workspace-script-tools.test.ts` 覆盖：

- 真实 Python 进程执行工作空间脚本。
- 参数类型校验在启动前完成。
- 非零退出返回 stderr 尾部和结构化 result。
- 超时后终止子进程。
- `AbortSignal` 取消运行中的脚本。
- 大 stdout 只保留尾部，保护 Agent 上下文。

## 已知边界

- 还未实现 venv/conda 自动创建和依赖安装。
- 还未实现系统级网络禁用和内存限制。
- 还未实现输出文件登记、运行历史归档和 `_runs/` 目录管理。
- 当前是脚本级 runner，不是交互式终端或 REPL。
