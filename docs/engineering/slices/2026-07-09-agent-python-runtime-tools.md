# 2026-07-09 Agent Python Runtime 工具切片

## 范围

本切片实现 Agent 内置 Python 工具，不涉及前端 UI，不新增依赖。

## 变更

- 新增 `packages/core-tools/src/python-runtime-tools.ts`。
- 新增工具：
  - `run_python_script`
  - `python_repl`
  - `install_python_deps`
- `official.workspace-python` 增加三项静态工具和高风险权限 `workspace.python.execute`。
- desktop Agent 工具装配层注入 active workspace 的 Python runtime 配置。
- 新增真实 Python 子进程测试。

## 验收

- 三项工具均为 high-risk、非 readonly、official source。
- `run_python_script` 只能在 active workspace 内执行，并复用运行归档。
- `python_repl` 可以真实执行短代码并截断大输出。
- `install_python_deps` 可以通过真实 pip 安装空 requirements，并拒绝 pip option 注入。
- readonly、未审批、无 active workspace 都会在启动 Python 前失败。
- AbortSignal 能取消运行中的 Python snippet。

## 风险

- 当前没有内存限制和网络隔离。
- pip 长任务没有流式进度。
- requirements 冲突分析和供应链审计还未实现。
