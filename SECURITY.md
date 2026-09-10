# Security policy

## English

SchemaNaut is alpha software with a local terminal product surface. It is not a
network server, public SDK/API, or web interface.

### Authorization boundary

Authorization comes only from the global config.toml permission mode and
organization rules. default requires approval for internet access and edits
outside the workspace. auto requires approval only for statically declared
high-risk actions and organization rules. full-access does not automatically
block actions for approval. A project, Skill, MCP server, or Capability cannot
raise these permissions. If require_sandbox is configured, it is an
organization-wide execution rule, not a content-safety feature.

### What users remain responsible for

SchemaNaut does not inspect content to find sensitive information, redact
Secrets, intercept credential-like command arguments, assess the trustworthiness
of a third-party CLI, Skill, MCP server, or Capability, or make external output
safe. Command stdout/stderr and provider errors may enter Agent results and
local retention subject only to general size and lifecycle limits.

The one narrow API isolation is for the built-in HTTP/browser bridge: Cookie and
Set-Cookie values are not placed in Agent-facing schemas, prepared intents,
results, or the Journal. It does not inspect, redact, or classify web bodies,
external command output, or user browser-test code output. SchemaNaut has no
embedded Chromium; Browser Capability uses an externally prepared
browser/Playwright environment and login state and has no Cookie parameter.

You are responsible for your prompts and files, model endpoint and external tool
configuration, third-party output, and the sensitivity of local logs, Journal,
Artifacts, and retained results. Keep real credentials out of Git as repository
hygiene; this is not a product redaction guarantee.

### Reporting a vulnerability

Please use the repository’s **Security → Report a vulnerability** flow to submit
a private GitHub Security Advisory. Do not disclose a suspected vulnerability in
a public issue before a fix is available. Do not include live credentials,
production data, or other sensitive material in the report.

## 中文

SchemaNaut 是 Alpha 软件，产品面为本地终端，不是网络 Server、公共 SDK/API 或 Web 界面。

### 授权边界

授权只来自全局 config.toml 的权限档位和组织规则。default 对互联网访问和工作区外编辑要求批准；
auto 只对静态声明的高风险动作和组织规则要求批准；full-access 不会自动拦截动作等待批准。项目、
Skill、MCP Server 和 Capability 均不能提高这些权限。若配置 require_sandbox，它是组织范围的执行
规则，不是内容安全功能。

### 用户仍需负责的内容

SchemaNaut 不检查内容以识别敏感信息，不做 Secret 脱敏，不拦截类似凭据的命令参数，不判断第三方
CLI、Skill、MCP Server 或 Capability 是否可信，也不负责使外部输出安全。命令 stdout/stderr 和
Provider 错误可以进入 Agent 结果和本地 retention，仅受通用大小与生命周期限制。

唯一狭义的 API 隔离针对内置 HTTP/browser bridge：Cookie 和 Set-Cookie 值不会进入面向 Agent 的 schema、
prepared intent、结果或 Journal。它不检查、脱敏或分类网页正文、外部命令输出或用户 browser_test 代码输出。
SchemaNaut 没有内嵌 Chromium；Browser Capability 使用在产品外准备好的浏览器/Playwright 环境和登录态，
不提供 Cookie 参数。

你需要负责 prompt 和文件、模型 Endpoint 和外部工具配置、第三方输出，以及本地日志、Journal、
Artifact 和保留结果的敏感性。不要把真实凭据提交到 Git 是仓库卫生要求，而不是产品脱敏保证。

### 报告漏洞

请通过仓库的 **Security → Report a vulnerability** 提交私有 GitHub Security Advisory。在修复可用
前，请勿在公开 Issue 中披露疑似漏洞。报告中不要包含真实凭据、生产数据或其他敏感材料。
