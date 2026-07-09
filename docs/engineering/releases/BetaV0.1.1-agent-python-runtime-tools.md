# BetaV0.1.1 Agent Python Runtime 工具

## 用户价值

Agent 现在不只可以发现声明式 `workspace_script:*`，还具备三个基础 Python 官方工具：运行脚本、执行短代码、安装依赖。这让后续数据分析、建模、可视化和脚本自修复工作流可以在后端先跑通。

## 本次内容

- 新增 `run_python_script`。
- 新增 `python_repl`。
- 新增 `install_python_deps`。
- 接入 `official.workspace-python` 官方插件策略。
- 接入 desktop headless Agent 工具装配层。
- 复用当前 workspace Python runtime，支持 system、venv、conda 解析后的执行路径。

## 测试结果

- `tsc -p packages/core-tools/tsconfig.json --noEmit` 通过。
- `tsc -b apps/desktop/tsconfig.json --pretty false` 通过。
- `vitest run packages/core-tools/test/python-runtime-tools.test.ts packages/core-tools/test/official-plugin-registry.test.ts packages/core-tools/test/official-plugin-tool-policy.test.ts apps/desktop/src/main/agent-tool-bootstrap.test.ts --passWithNoTests` 通过，32 个测试全部通过。
- touched files eslint 通过。

## 后续计划

- 为 pip 安装增加流式进度和取消后的进程树清理。
- 增加 Python runtime 网络/内存限制策略。
- 接入 Agent audit log，记录脚本路径、依赖安装摘要、耗时和失败原因。
