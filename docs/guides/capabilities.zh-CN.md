# Capability 指南

下列第一方 Capability 正在本轮开发中。它们是按任务使用的增强，不是 SchemaNaut 配置模块。

| Capability | 常见外部条件 |
| --- | --- |
| Git | git 可执行文件；需要时还需 Git 工作区。 |
| Database | 在 SchemaNaut 外管理的数据库连接信息。 |
| Forge | gh 或 glab 命令行客户端及其外部登录状态。 |
| Containers | docker 或 podman 命令行客户端；需要时还需对应服务。 |
| Browser Automation | 已安装的 Playwright CLI 和浏览器环境。 |
| Language Intelligence | tsc、pyright、ruff、cargo、go 或 ctags 等语言工具。 |
| Documents | 当前操作所需的 pandoc、pdftotext 或 pdfinfo。 |
| Data & Notebook | 可读取的数据文件；运行 notebook 还需要 Jupyter。 |

## 授权与责任

每个 Tool 静态声明其操作事实，例如工作区写入、联网、外部写入、破坏性或高风险。SchemaNaut 不扫描
用户请求、命令参数、输出或第三方响应来识别 Secret 或凭据，也不判断外部工具是否可信。全局
default、auto、full-access 和组织规则决定授权。

外部命令输出和 Provider 错误可以进入 Agent 结果和本地 retention，仅受通用大小与生命周期限制。
用户负责输入、外部配置、模型 Endpoint、本地日志、Journal、Artifact 和第三方输出的敏感性。不要把
真实凭据提交到 Git。

请使用相应外部流程修复缺少条件，然后重试或重新发现任务。父进程 PATH 或环境改变时，需要重启终端
Host。
