# SchemaNaut 终端指南

## 从源码运行

    pnpm install
    pnpm build:terminal
    node apps/terminal/dist/cli.js init ./my-project
    node apps/terminal/dist/cli.js chat -C ./my-project

## 模型与项目设置

全局 ~/.schemanaut/config.toml 保存模型连接、模型默认值、权限档位和组织规则。项目设置只声明 MCP
Server。模型选择属于 Session。

    /models
    /model 1

## 命令

| 命令 | 作用 |
| --- | --- |
| /settings [show\|path\|validate] | 查看、定位或校验项目 MCP 设置。 |
| /config [show\|path\|validate] | 查看、定位或校验全局配置。 |
| /models | 从全局连接刷新模型。 |
| /model [list\|current\|序号\|模型名] | 列出、检查或选择 Session 模型。 |
| /new、/resume、/sessions、/run resume | 新建或恢复持久工作。 |
| /skills | 检查或重新加载 Markdown Skill。 |
| /mcp [list\|start\|stop\|doctor] | 查看或控制已配置的 MCP Server。 |
| /doctor | 检查全局配置、模型、Skill 与 MCP。 |
| /compact、/cancel、/trace | 控制活跃 Run。 |

## 授权与责任

default 对互联网访问和工作区外编辑要求批准；auto 只对静态声明的高风险动作和组织规则要求批准；
full-access 不会自动拦截动作等待批准。不存在项目级覆盖。

SchemaNaut 不脱敏配置视图、命令参数、命令输出或 Provider 错误；不扫描它们以识别 Secret，也不判断
外部 CLI、Skill、MCP Server 或 Capability 是否可信。这些值可以进入 Agent 结果和本地 retention，
仅受通用大小与生命周期限制。用户负责其敏感性，并负责不把真实凭据提交到 Git。

BrowserSession Host Port/浏览器连接器复用用户在 SchemaNaut 外已登录的现有浏览器会话，只对 Cookie 值作狭义
API 隔离。该产品合同中 Agent 只获得不透明的 browser session/page 引用；面向 Agent 的 schema 不接受 Cookie、
API Header 或 Authorization，Cookie/Set-Cookie 不会进入 prepared intent、结果或 Journal。它不检查网页正文、
外部命令输出或用户 browser_test 代码输出。当前 CLI 没有内嵌 Chromium；外部 Playwright 仅作无登录截图/测试后端
或用户维护的测试配置，不保证共享登录态。基础 web_fetch 无状态；web_search API 凭据仍只允许 HTTPS。
