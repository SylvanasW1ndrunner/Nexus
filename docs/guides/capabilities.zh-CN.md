# Capability 指南

下列第一方 Capability 已内置到 bundled Agent Host。它们是按任务使用的增强，不是 SchemaNaut 配置模块。

Agent 首轮只看到基础 Tool 和 Capability 目录。`tool_search` 找到并激活一个 Capability 后，该 Capability
的完整工具集会在下一轮直接加载；不需要再逐个激活其中的 Tool。外部条件缺失时，Agent 会说明需要在
SchemaNaut 外完成的准备，并可在准备完成后重新发现。

基础工具面固定为 14 个 Tool：`ask_user`、`tool_search`、`result_read`、`result_materialize`、
`result_save`、`skill`、`workspace_list`、`workspace_read`、`workspace_search`、
`workspace_apply_patch`、`process_exec`、`process_control`、`web_search` 和 `web_fetch`。
搜索可以只展示匹配项而不加载；选择匹配项才会惰性探测外部状态，并安排完整 Capability Toolset 在下一轮生效。

同一个模块可能用多个目录名表达不同用途，例如数据库查询和 Schema 检索。选择这些名字仍只会加载
同一个模块实例；重复选择会被当作已经激活，不需要用户理解或处理内部 binding。

| Capability | 常见外部条件 |
| --- | --- |
| Git | git 可执行文件；需要时还需 Git 工作区。 |
| Database | 在 SchemaNaut 外管理的 `DATABASE_URL` 或受支持的 `PG*` 连接状态。 |
| Forge | gh 或 glab 命令行客户端及其外部登录状态。 |
| Containers | docker 或 podman 命令行客户端；需要时还需对应服务。 |
| Browser Automation | BrowserSession Host Port/浏览器连接器复用现有浏览器登录态，但不提供 Agent Cookie/API Header/Authorization 参数；CLI 无内嵌 Chromium，外部 Playwright 仅作无登录截图/测试后端或用户维护的测试配置。 |
| Language Intelligence | tsc、pyright、ruff、cargo、go 或 ctags 等语言工具。 |
| Documents | 当前操作所需的 pandoc、pdftotext 或 pdfinfo。 |
| Data & Notebook | 可读取的数据文件；运行 notebook 还需要 Jupyter。 |

Database Capability 不只用于单次 SQL 查询。Agent 可以先用 SQL 生成紧凑的数据集，再通过始终加载的
结果读取、工作区和进程工具编写并运行 Python 分析脚本。这个组合不需要在 SchemaNaut 中配置 Python
或数据库插件；数据库连接和 Python 运行时仍由用户在程序外准备。缺少 Python 包时，Agent 应优先使用
标准库或说明缺失条件，而不是把包管理变成 Capability 配置。

## 准备浏览器自动化会话

Browser Automation v1 使用本机 CDP 连接，而不是 Claude 浏览器扩展。使用前，请在
SchemaNaut 外准备浏览器：

1. 以本机端口 `9222` 的远程调试模式启动 Chrome 或 Edge，并为它指定一个专用浏览器
   Profile。较新的 Chrome 版本可能要求远程调试使用非默认的 user-data directory，因此请使用
   独立的 Profile 目录，不要使用平时的默认 Profile。
2. 在该 Profile 中登录需要使用的网站，然后保持浏览器运行。
3. 重试浏览器任务。SchemaNaut 只会连接 `http://127.0.0.1:9222`，并复用该 Profile
   现有的登录态。

连接器始终为其工作新建专用的 `about:blank` 标签页；不会附着或接管你已有的标签页，也不能
自动附着到未以远程调试模式启动的普通 Chrome 或 Edge 会话。未来可由扩展或原生 bridge 替换
本机 CDP 准备方式，但面向 Agent 的 browser session/page 合同保持不变。

## 授权与责任

每个 Tool 静态声明其操作事实，例如工作区写入、联网、外部写入、破坏性或高风险。SchemaNaut 不扫描
用户请求、命令参数、输出或第三方响应来识别 Secret 或凭据，也不判断外部工具是否可信。全局
default、auto、full-access 和组织规则决定授权。

外部命令输出和 Provider 错误可以进入 Agent 结果和本地 retention，仅受通用大小与生命周期限制。
用户负责输入、外部配置、模型 Endpoint、本地日志、Journal、Artifact 和第三方输出的敏感性。不要把
真实凭据提交到 Git。

BrowserSession Host Port/浏览器连接器有唯一狭义 API 隔离：浏览器协议和会话中的 Cookie/Set-Cookie 字段和值不会进入面向 Agent 的 schema、
prepared intent、结果或 Journal；该产品合同中 Agent 只获得不透明的 browser session/page 引用，Cookie、API
Header 和 Authorization 不是 Agent 参数。它不扫描或脱敏网页正文、
外部命令输出或用户 browser_test 代码输出。导航只校验 URL 是 HTTP(S)；不会另外识别或拦截 URL 中的
userinfo。

请使用相应外部流程修复缺少条件，然后重试或重新发现任务。父进程 PATH 或环境改变时，需要重启终端
Host。
