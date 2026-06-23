# BetaV0.1.1 Workspace Python 运行归档

## 范围

本切片为 `packages/core-tools` 的 Python runner 增加脚本运行归档与 workspace history 审计。不涉及前端 UI。

## 用户场景

用户或 Agent 执行 Python 分析脚本后，需要能回看：

- 当时执行的是哪个脚本。
- stdout/stderr 输出是什么。
- 脚本是否成功、失败、超时或被取消。
- 运行结果保存在工作空间哪个目录。

这对数据分析、报表生成和 Agent 自修复都很重要。没有归档时，脚本输出只存在于当前调用结果里，用户很难复查或复现。

## 实现

- `runWorkspacePythonScript()` 默认归档运行结果。
- 每次运行写入：
  - `scripts/_runs/<runId>/stdout.log`
  - `scripts/_runs/<runId>/stderr.log`
  - `scripts/_runs/<runId>/result.json`
  - `.dbagent/history.jsonl`
- `WorkspaceScriptRunResult` 增加：
  - `runId`
  - `archiveRelativePath`
  - `stdoutRelativePath`
  - `stderrRelativePath`
  - `resultRelativePath`
  - `historyRelativePath`
- `result.json` 记录命令摘要、退出码、signal、耗时、超时/取消状态、截断标记和输出文件路径。
- `history.jsonl` 记录脚本路径、run id、归档路径、耗时、退出码和状态标记。
- `_runs` 默认保留最近 50 次运行目录，超过后删除最旧 run 目录。

## 隐私边界

归档和 history 不保存：

- 脚本参数 `args`。
- 环境变量 `env`。
- 数据库凭证。
- LLM API key。

stdout/stderr 本身可能由脚本打印业务数据，因此默认已经受 `outputLimitBytes` 限制，只保存返回给 Agent 的同一份尾部输出。后续需要在主进程层为敏感项目提供更细的输出脱敏策略。

## 开源与依赖评估

本切片未引入新依赖。原因：

- 运行归档是文件写入和 JSONL 审计，Node 原生 `fs/promises` 足够。
- 不引入日志数据库或压缩库，避免增加 Electron 打包和离线安装风险。
- 后续如果运行历史规模增大，再评估 SQLite WAL 或分段日志。

## 测试

`packages/core-tools/test/workspace-script-tools.test.ts` 覆盖：

- 成功运行后写入 stdout、stderr、result manifest 和 history。
- history 不包含敏感参数。
- 失败运行在抛出 `WorkspaceScriptExecutionError` 前也完成归档。
- 既有非零退出、超时、取消和输出截断测试保持通过。

## 已知边界

- 还未扫描脚本生成的图片、CSV 等产物并登记到 manifest。
- 还未实现运行历史查询 API。
- stdout/stderr 不做语义脱敏，只做大小限制。
