# 2026-07-07 桌面端诊断报告服务切片

## 背景

`core-tools` 已经提供诊断报告构建和脱敏规则，但它只接受调用方传入的文本，不负责读取桌面端真实目录，也不负责落盘。上一切片已经把 Agent 审计日志写入 `Electron userData/logs/agent-YYYY-MM-DD.jsonl`，如果诊断报告不能收集这些日志，Agent/RAG 后续验收和用户反馈仍缺少完整证据链。

本切片把诊断报告接入桌面主进程，继续保持前端 UI 冻结。

## 变更范围

- 新增 `apps/desktop/src/main/diagnostic-report-service.ts`。
- 新增 typed IPC：`app:generate-diagnostic-report`。
- 主进程通过 `DesktopDiagnosticReportService` 扫描桌面端配置、日志、Agent 审计日志和 crash 快照。
- 调用 `@dbagent/core-tools/buildDiagnosticReport()` 完成统一脱敏和报告文件生成。
- 报告输出为目录：`Electron userData/diagnostic-reports/diagnostic-<timestamp>-<hash>/`。

## 收集范围

配置文件白名单：

- `connections.json`
- `workspace-state.json`
- `workspaces.json`
- `plugins.json`
- `ide-settings.json`

日志文件白名单：

- `main.log`
- `app-*.log`
- `renderer-*.log`
- `agent-*.jsonl`

崩溃快照白名单：

- `crash-*.dump`
- `crash-*.log`
- `crash-*.txt`
- `crash-*.json`

`credentials.json` 不进入诊断报告收集范围。

## 安全边界

- renderer 只拿到报告目录、文件数、字节数、脱敏次数等摘要，不直接拿报告内容。
- 写入报告文件时使用 `resolveReportFilePath()` 校验路径，阻止 report file path 逃逸报告目录。
- 源文件按尾部读取，默认最多读取最近 768KB，避免大日志拖垮应用。
- 报告内容继续由 `core-tools` 统一脱敏，覆盖 API key、Bearer token、password/token/secret 字段和 SQL 片段。
- 不引入压缩库，不生成 zip；这是后续打包体验切片，当前先保证无 UI 后端能力可测试。

## 开源方案评估

本切片没有引入 `archiver`、`yazl`、`jszip` 或系统 zip 命令。原因是当前目标是把真实目录采集、脱敏和落盘闭环跑通，目录输出已经能供测试和手动反馈使用；压缩包涉及依赖体积、Electron 打包、Windows/Linux 路径兼容和大文件流式写入策略，应单独评估。

诊断报告的结构参考成熟桌面工具的“manifest + logs + config + crash”模式，但实现保持本地纯 Node.js 文件系统能力，方便离线运行和测试。

## 验收

- 真实临时文件系统中写入配置、主进程日志、Agent JSONL 审计日志和 crash dump 后，服务能生成报告目录。
- 报告包含 manifest、配置、日志和 crash 文件。
- `credentials.json`、无关临时文件不会进入报告。
- SQL、API key、Bearer token、password 字段和 crash secret 均被脱敏。
- 缺失日志目录不会导致生成失败。
- 逃逸路径会被拒绝。

## 后续

- 增加 zip 写入和校验，形成用户可直接上传的单文件诊断包。
- 把 PostgreSQL 诊断、插件健康状态、MCP 健康状态写入诊断报告。
- 在最终 UI 重建阶段把该 IPC 接到“帮助 / 生成诊断报告”入口。
- 下一优先级建议：补真实 PostgreSQL 查询取消端到端测试，或补真实 PostgreSQL + 真实 LLM 的 Agent/RAG 联合验收；这两项是当前测试 Agent 标出的 P0 风险。
