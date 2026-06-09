# BetaV0.1.1 Python 运行体验优化

## 背景

Python 是数据工程师和分析师处理数据的核心工作流。底层已经具备 `python:run-script` 执行能力，但编辑器交互和终端输出需要更接近 IDE 的使用方式。

## 实现内容

- 编辑器右键菜单从仅支持 SQL 扩展为按文件类型展示：
  - SQL 文件：运行选中 SQL、运行整个 SQL 文件、Explain、保存文件。
  - Python 文件：运行当前 Python 文件。
- Python 运行结果统一写入底部终端面板。
- 终端输出统一包含：
  - 实际执行命令。
  - 工作目录。
  - stdout。
  - stderr。
  - 退出码和耗时。
- Python 运行成功判断统一为退出码 `0`。

## 测试覆盖

- `python-run-output.test.ts` 覆盖终端 transcript 格式。
- `python-environment.test.ts` 已覆盖系统 Python 可用时执行内联代码和工作区相对路径脚本。
- TypeScript 检查覆盖编辑器右键菜单回调和 Python 输出格式调用链。

## 后续优化

- 将 Python 运行状态流式写入终端，而不是执行完成后一次性输出。
- 增加运行配置，例如脚本参数、环境变量、超时时间和工作目录。
- 在 Python 文件标签或状态栏展示最近一次运行状态。
