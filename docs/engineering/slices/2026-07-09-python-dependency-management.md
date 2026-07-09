# 2026-07-09 Python 依赖验证与安装切片

## 范围

本切片补齐 Desktop 主进程的 Python 依赖服务，不涉及前端 UI，不改变多数据库路线。

## 变更

- shared IPC 新增：
  - `python:verify-dependencies`
  - `python:install-dependencies`
- `PythonEnvironmentService` 新增：
  - 真实解释器模块可导入性验证。
  - requirements / package spec pip 安装。
  - workspace 路径越界校验和 package option 注入拦截。
- `main.ts` 注册对应 IPC handler。

## 验收

- TypeScript shared 编译通过。
- Desktop TypeScript build 通过。
- Python service 测试通过，覆盖真实 Python、真实 pip、越界路径和注入拦截。

## 风险

- 当前安装是一次性 `pip install`，还没有流式进度、取消和安装日志归档。
- 当前不解析 requirements 内容，不提供依赖冲突解释。
- 如果用户环境没有 pip，安装会返回失败结果，由上层 UI 或 Agent 诊断展示。
