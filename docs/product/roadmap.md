# SchemaNaut 路线图

本路线图说明用户可见方向，不构成公共 API、发布时间或性能领先承诺。

## 当前已经具备

- `schemanaut` 是唯一受支持的用户入口；产品保持 Terminal-only、CLI-only。
- 每个任务始终拥有 14 个基础 Tool，并可按任务激活 Git、Database、Forge、Containers、Browser Automation、
  Language Intelligence、Documents、Data & Notebook 八类第一方 Capability。
- Capability 复用用户在产品外管理的 CLI、文件、环境变量、服务和登录态，不拥有程序内配置。
- 全局 `config.toml` 是模型默认值、三档权限和组织规则的唯一来源；项目 settings 只保存 MCP 声明。
- 基础 Tool、Capability、Skill 与 MCP 共用统一执行主干、权限、取消、结果和 Journal 语义。
- 数据库结果可以有界读取、按 Run 临时物化给本地 Python/进程处理，并在用户明确要求时持久保存。
- Browser Automation 可以连接用户自行启动的本机远程调试专用 Profile，并复用其中的登录态。

“已经具备”表示代码和确定性合同已存在，不表示每台机器都已经安装外部 CLI、数据库、浏览器或语言运行时，
也不表示所有真实模型和 Provider 场景都已通过。

## 发布收口

- 完成 CLI-only npm 候选的可复现打包、校验和、provenance 与隔离安装验证。
- 统一用户文档、终端帮助、Capability 状态和当前发布边界。
- 在最终产品名确认后，一次性迁移仓库、包名、CLI、配置目录和文档，不保留双名称兼容层。

远程 npm 发布由维护者执行；本地发布脚本不会自动发布到 Registry。

## 能力与体验优化

- 继续减少 Capability 发现、选择和失败重试所需的模型 Turn 与 Token。
- 扩展数据库与本地 Python 的真实分析任务，覆盖更长结果、更复杂验证和中断恢复。
- 为浏览器探索 extension 或 native bridge，减少手工启动远程调试 Profile 的准备步骤，同时保留 Agent-facing
  session/page 引用边界。
- 改进 Tool 结果摘要、动作说明、长任务活动视图和可恢复交付体验。

## 横向 Benchmark

我们会先做相同模型下的“基础命令执行 vs 按任务 Capability”消融，再做 SchemaNaut、Claude Code、Codex 等
产品的端到端对比。评测覆盖正确性、时间、Token、模型 Turn、Tool 调用、重试、人工批准和恢复表现。

当前只发布[评测合同](../benchmarks/README.md)，不提前发布没有可复现实验支持的“更快”或“更省”结论。

## 不在近期范围

- WebUI、公共 SDK、HTTP Server 或传统数据库 IDE；
- 自动敏感信息识别、通用 DLP 或第三方来源可信度评分；
- 在所有平台上承诺强操作系统沙盒；
- 在外部依赖缺失时由产品静默安装或接管用户环境。
