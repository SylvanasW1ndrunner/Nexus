# BetaV0.1.1 Workspace Python 运行归档保留策略

## 范围

本切片为 `packages/core-tools` 的 Python runner 增加 `_runs` 归档保留数量清理。不涉及前端 UI。

## 用户场景

用户和 Agent 会频繁运行分析脚本。每次运行都会写入 stdout、stderr 和 result manifest，如果不清理，`scripts/_runs` 会持续膨胀，影响工作空间体积和同步成本。

## 实现

- `WorkspaceScriptRunRequest.archiveRetention`：可配置归档保留数量。
- 默认保留最近 50 次运行目录。
- 清理范围只限 `scripts/_runs` 下的 run 目录。
- 排序依据优先使用每个 run 目录内 `result.json` 的修改时间；缺失时使用目录修改时间。
- 清理后，`WorkspaceScriptRunResult.prunedArchiveRelativePaths` 返回被删除的 run 目录相对路径。
- `.dbagent/history.jsonl` 不清理，保留审计记录。

## 隐私与安全

清理逻辑不读取脚本参数或环境变量，只基于目录和文件元数据。它不会删除 `outputs/`、`docs/`、`scripts/*.py` 或 `.dbagent/history.jsonl`。

## 开源与依赖评估

未引入新依赖。归档清理是文件系统元数据排序和目录删除，Node 原生 `fs/promises` 已满足需求。后续如果运行历史规模扩大，再评估 SQLite WAL 或更完整的 workspace maintenance service。

## 测试

`packages/core-tools/test/workspace-script-tools.test.ts` 覆盖：

- 连续运行 4 次脚本。
- 设置 `archiveRetention: 2`。
- 确认旧 run 目录被删除，最新 2 个 run 保留。
- 确认 history 中仍保留旧 run 审计记录。

## 已知边界

- 当前只按数量清理，不按磁盘大小或运行时间清理。
- 未扫描脚本生成的图片、CSV 等产物并关联清理。
- 未提供独立运行历史查询 API。
