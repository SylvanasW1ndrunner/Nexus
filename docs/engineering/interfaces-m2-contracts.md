# M2+ 非 UI 服务合约预留

本文补充 M2+ 阶段的服务合约方向。正式接口仍应在实现切片中落到 `packages/shared`、对应 core 包导出类型或 Electron typed IPC。

## RAG 合约

后续 RAG 能力至少需要稳定以下非 UI 合约：

- 重建索引：按 connection/workspace 触发 schema 抽取、文档生成、FTS/向量索引。
- 查询索引：输入自然语言问题、连接上下文和 topK，返回 table/column/relation 命中、分数、来源和截断信息。
- 构建上下文：将检索结果转换为 Agent 可用的 schema context。
- 索引状态：返回 stage、progress、lastUpdated、error、是否需要重建。
- 清理索引：断开连接或删除连接时清理对应 RAG storage。

## Agent 合约

后续 Agent 能力至少需要稳定以下非 UI 合约：

- 启动 run：输入 session、模型、工具白名单、权限模式、用户任务。
- 流式事件：message delta、tool call、tool result、approval request、usage、checkpoint、error、finish。
- 中止 run：按 run id 取消模型调用、工具调用和长任务。
- 恢复 run：从 checkpoint/session store 恢复可恢复任务。
- Eval run：用真实业务 case 验证工具调用、权限、RAG 命中和最终回答。

## MCP / Plugin 合约

后续 MCP 和插件市场能力至少需要稳定以下非 UI 合约：

- 插件 manifest：id、name、version、source、permissions、contributes、lifecycle。
- 安装/启用/禁用/卸载：原子配置写入、secret ref、健康检查和回滚。
- Tool Registry 映射：统一 tool schema、result schema、danger level、readonly、audit metadata。
- 运行时健康：started、stopped、disabled、failed、timeout、missing_env、crashed。
- 审计：调用方、工具 id、参数摘要、耗时、状态、脱敏错误。

## Workspace / Python / Terminal 合约

后续 workspace 和进程能力至少需要稳定以下非 UI 合约：

- Python runtime 检测：system、venv、conda、embedded、docker 的候选路径、版本、可用性和错误原因。
- Python 执行：脚本路径、cwd、环境、stdin/stdout/stderr、退出码、超时、取消和输出归档。
- Terminal session：创建、写入、resize、关闭、cwd、shell、输出 buffer、退出状态。
- Workspace 文件：只允许相对路径和受管目录，拒绝 `.dbagent`、绝对路径和 `..` 逃逸。

## Auth / Config / Usage 合约

后续认证和配置能力至少需要稳定以下非 UI 合约：

- 本地 PostgreSQL 账户：注册、登录、验证码登录、忘记密码、密码 hash、测试账号。
- Provider 配置：OpenAI-compatible、SiliconFlow、Ollama、vLLM、Anthropic 等 provider template。
- Secret 引用：JSON 只保存 ref，secret 存 keychain 或等价 secret backend。
- Usage：本地 SQL、Agent round、LLM token、失败/中止/成功状态和订阅/gateway 预留。

