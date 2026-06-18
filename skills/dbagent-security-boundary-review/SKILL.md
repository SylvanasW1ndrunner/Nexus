---
name: dbagent-security-boundary-review
description: Use when designing, implementing, reviewing, or testing DBAgent/Nexus security boundaries for credentials, database writes, SQL audit, renderer exposure, filesystem paths, subprocesses, Python execution, MCP tools, LLM calls, logs, diagnostics, or network access.
---

# DBAgent 安全边界审查

用于确保后端功能切片不会泄露凭证、误执行危险操作、越权访问文件或把敏感数据暴露给 renderer、日志、LLM、MCP 或诊断包。

## 必读文档

按风险读取对应文档：

- 凭证、Provider、MCP、IPC：`docs/product/04-config-design.md`
- Agent 权限、工具调用、SQL 预审：`docs/product/03-agent-design.md`
- SQL、表编辑、导入导出、传统数据库操作：`docs/product/06-classic-features.md`
- 工作空间、Python、脚本即工具：`docs/product/08-workspace-design.md`
- 崩溃恢复、诊断报告、日志脱敏：`docs/product/09-error-recovery.md`
- 登录、JWT、用量、gateway：`docs/product/10-usage-and-subscription.md`
- 开发规范、Electron 安全、密钥不进 renderer：`docs/product/05-development-guide.md`

## 审查流程

1. 确定功能会触碰的安全面：凭证、SQL 写操作、文件系统、子进程、网络、LLM、MCP、诊断日志。
2. 标出可信边界：core 包、main process、preload、renderer、外部服务、用户数据库、workspace 目录。
3. 验证敏感数据只在允许层级存在；renderer 只能拿到脱敏结果或引用。
4. 检查所有外部输入都有验证：IPC request、配置文件、SQL、路径、环境变量、MCP 安装配置、LLM 输出。
5. 为每个高风险动作写拒绝、确认、回滚、超时、取消、审计和恢复路径。
6. 补测试和中文文档；不能只靠代码注释说明安全设计。

## 安全检查清单

- 凭证：DB 密码、API key、JWT、SSH key、MCP env secret 只能存在 keychain、进程内临时变量或受控测试环境。
- Renderer：不得接收明文密钥、完整连接 URL、无限制本地路径、原始诊断日志或未脱敏错误。
- SQL：写操作必须有风险评级、影响范围估计、事务保护或明确不可回滚说明。
- 只读模式：必须在工具层和 SQL 审计层双重拦截写操作。
- 文件系统：workspace 工具默认限制在 workspace；删除、覆盖和批量写入必须可审计。
- 子进程：Python、shell、MCP 进程必须有超时、退出码、stdout/stderr 上限和 kill 行为。
- 网络：远程数据库、LLM、MCP market、gateway 调用必须有超时、重试、错误分类和脱敏日志。
- 日志：不得写入 SQL 结果集中的敏感字段、完整 prompt、密钥、验证码、JWT、连接串。
- 诊断包：必须自动脱敏，并记录脱敏规则。

## 测试要求

- 至少覆盖一个拒绝路径：权限不足、只读模式、危险 SQL、越界路径或明文 secret。
- 至少覆盖一个恢复路径：事务 rollback、子进程 kill、配置损坏恢复或网络失败降级。
- 对凭证处理做 secret scan，确认测试快照和 release note 中没有真实 key。
- 对 IPC 或服务边界添加输入畸形测试。

## 输出格式

```markdown
## 安全边界审查

涉及能力：

读取文档：

风险面：

可信边界：

必须阻断：

必须确认：

必须审计：

测试要求：

文档要求：
```
