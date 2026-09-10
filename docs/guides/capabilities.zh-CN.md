# Capability 指南

Capability 是可选的、按任务使用的工具集。下列第一方范围正在本轮开发中；各工具集只有在整合进终端后
才可使用。它们使用你已经自行管理的外部条件，例如已安装命令、文件、环境变量、登录状态或可用服务；
不会新增 SchemaNaut 项目设置或程序内设置表单。

## 第一方范围

| Capability | 常见外部前置条件 |
| --- | --- |
| Git | git 可执行文件；需要操作时还需 Git 工作区。 |
| Database | DATABASE_URL 或 PostgreSQL 标准环境变量。 |
| Forge | 已登录的 gh 或 glab 命令行客户端。 |
| Containers | docker 或 podman 命令行客户端；需要时还应具备对应服务。 |
| Browser Automation | 已安装的 Playwright CLI，以及在 SchemaNaut 外准备好的浏览器环境。 |
| Language Intelligence | tsc、pyright、ruff、cargo、go 或 ctags 等相关工具。 |
| Documents | 当前操作所需的 pandoc、pdftotext 或 pdfinfo 工具。 |
| Data & Notebook | 可读取的 JSON、JSONL、CSV 或 notebook 文件；运行 notebook 还需要 Jupyter。 |

整合后，Agent 会在任务需要时发现合适的 Capability。缺少其中某项不会阻止通用 Agent、Skill 或 MCP Server 工作。

## 不在 SchemaNaut 中配置 Capability

全局 ~/.schemanaut/config.toml 只用于模型连接、默认生成参数和组织范围权限。项目设置仅用于项目 MCP
声明。不要在这些文件中加入数据库 URL、Forge token、容器设置、浏览器 profile 或其他 Capability 配置。

请使用对应的外部工具、文件、安全引用、环境或登录流程管理前置条件。不要要求 Agent 把密钥写入项目文件。

## 使用自然语言请求协助

你可以直接告诉 Agent 想完成什么，例如：

- 检查当前 Git 改动，并准备一个供我审阅的提交。
- 解释数据库连接为何不可用，以及我需要修复什么。
- 使用这里已经安装的工具运行项目诊断。
- 将这个文档转换为 PDF，并保存到这个明确的路径。

Agent 可以使用通用工具或可用 Capability 协助用户请求的外部步骤。每个动作仍受同一套全局权限策略和
许可流程约束。

## 缺少依赖时

有用的诊断会指出缺少的前置条件、受影响的 Capability、应在 SchemaNaut 外修复的位置以及重试动作。
修复外部条件后，请 Agent 再次搜索或重试任务。命令、文件、登录、服务或环境发生变化后可以重新检查；
如果父进程环境本身发生变化，请先重启终端 Host 再重试。

诊断内容有边界且会脱敏，不会有意展示 token、密码、Authorization Header、完整连接串或 Provider 原始响应。
详见[诊断与沙盒指南](diagnostics-and-sandbox.zh-CN.md)。
