# BetaV0.1.1 Python 依赖验证与安装

## 用户价值

数据工程项目通常需要 pandas、numpy、数据库驱动或内部分析包。后端现在可以在运行脚本前确认模块是否可导入，并可以在目标 Python 环境内安装 requirements，为后续 Agent 自动修复脚本环境和正式前端设置页打基础。

## 本次内容

- 新增 Python 依赖验证 IPC。
- 新增 Python 依赖安装 IPC。
- 支持 system、venv、conda prefix、conda env name 的统一调用路径。
- requirements 路径限制在 Workspace 内。
- 拦截 pip option 注入，避免用户输入或 Agent 输入绕过安装策略。

## 测试结果

- `tsc -p packages/shared/tsconfig.json --noEmit` 通过。
- `tsc -b apps/desktop/tsconfig.json --pretty false` 通过。
- `vitest run apps/desktop/src/main/python-environment.test.ts --passWithNoTests` 通过，14 个测试全部通过。
- `node scripts/smoke.mjs` 通过。`pnpm smoke` 在当前机器被 pnpm ignored-builds 安装守卫拦截，失败发生在 install 前置检查，不是 smoke 脚本或本切片代码失败。

## 后续计划

- 接入 Workspace 打开时的 Python 环境诊断。
- 接入 Agent 运行 Python 脚本前的依赖检查。
- 为 pip 长任务增加取消、进度事件和日志归档。
