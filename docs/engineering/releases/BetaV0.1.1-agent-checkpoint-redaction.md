# BetaV0.1.1 Agent Checkpoint 脱敏

## 范围

本次切片增强 `core-agent` 的 checkpoint 安全边界，不涉及前端 UI。

新增能力：

- `AgentCheckpointStore` 在保存 checkpoint 前脱敏 session 快照、tool execution preview、finalText 和 errorMessage。
- `listBySession()` / `listRecoverable()` 读取历史 checkpoint 时也会脱敏，避免旧文件里的敏感值重新暴露。
- 脱敏覆盖常见 API key、Bearer token、数据库连接串密码、password/secret/token/authorization/dsn 等字段。
- 保留非敏感运行信息，例如 `tokenUsage`，避免影响恢复和用量诊断。

## 用户场景

- 用户配置 LLM provider、数据库连接或 MCP 工具失败时，checkpoint 不应把 API key、DB 密码或授权头写入可读 JSON。
- Agent 崩溃恢复扫描可以继续读取 checkpoint，但不会把旧版本未脱敏的凭证暴露给后续 UI、诊断报告或测试日志。

## 开源评估

候选方案：

- `fast-redact`：成熟、高性能，适合日志系统。
- `pino` redaction：适合后续统一日志链路。
- 当前自研确定性规则：适合本地 JSON checkpoint 的小范围写入/读取路径。

本次选择自研小规则，原因是当前 checkpoint store 不引入日志框架，也不需要高吞吐路径；新增依赖会增加打包和供应链面。后续如果日志、诊断报告、session store 和 SQLite checkpoint 统一脱敏，应把规则抽到公共模块，并重新评估复用成熟 redaction 库。

## 测试

已覆盖：

- checkpoint 中的 tool arguments、tool execution preview、finalText、errorMessage 脱敏。
- 历史 raw checkpoint 文件读取时脱敏。
- `tokenUsage` 等非敏感字段不被误删。
- ReactAgent checkpoint 集成测试保持通过。

## 打包影响

无新增依赖。仅使用 TypeScript 和 Node.js 运行时能力。
