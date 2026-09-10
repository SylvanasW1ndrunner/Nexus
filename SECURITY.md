# Security Policy / 安全策略

[English](#english) · [中文](#中文)

## English

SchemaNaut is alpha software. Its supported product surface is a local
terminal, not a network server. It currently provides no HTTP listener, public
SDK/API, or Web UI; do not infer one from internal workspace code.

### Operating safely

- Treat `~/.schemanaut/config.toml` and its environment or secure-store secret
  references as sensitive configuration. Model endpoints and defaults belong
  there; model secrets must never be plaintext in global or project settings.
  Project `.schemanaut/settings.json` is limited to project-scope declarations
  such as MCP servers and must not contain model or Capability configuration.
- A model endpoint receives the prompt and any model-bound context. Confirm the
  endpoint's identity, transport security, retention policy, and credentials
  before using it with sensitive code or data.
- MCP configuration can launch a local process (`stdio`) or contact a remote
  endpoint (`sse` or `streamable-http`). Review its command, arguments,
  working directory, URL, environment, headers, and the tools it exposes.
  Do not treat a configured MCP server as trusted by default.
- Project/workspace and process tools can inspect files, write files, or start
  processes. Set the global permission mode in `~/.schemanaut/config.toml` to
  `default` for unfamiliar work; use `auto` or `full-access` only in a trusted
  environment. Global enterprise `allow`/`ask`/`deny` rules remain in force
  and cannot be relaxed by a project.
- Database terminal configuration and commands are not implemented. Capability
  prerequisites belong outside SchemaNaut project settings; failures should
  identify an actionable missing external condition and can be retried after it
  changes.
- Local Sessions, Runs, artifacts, and state live in the project’s
  `.schemanaut/` area. Protect, back up, and remove that directory according to
  your project’s data-retention policy. It can include task history and
  references to local outputs.

Model credentials are supplied only through environment variables or secure
references resolved on the local machine. Never put secrets in repositories,
Skill files, prompts, diagnostics, Journal data, or bug reports. MCP values are
also security-sensitive; review their source and restrict local file access.

Skills and MCP servers are not given trust scores. Their Tools nevertheless use
the same registration, invocation, permission, approval, audit, cancellation,
and recovery boundaries as built-in and Capability Tools.

### Reporting a vulnerability

Please use the repository’s **Security → Report a vulnerability** flow to
submit a private GitHub Security Advisory. Do not disclose a suspected
vulnerability in a public issue before a fix is available.

Include the affected version or commit, reproduction steps, impact, and any
suggested mitigation. Never include live API keys, database passwords,
production data, project state, or other secrets.

### Supported versions

Until the first stable release, security fixes target the latest commit on
`dev` and the next local release artifact.

## 中文

SchemaNaut 仍处于 Alpha 阶段。受支持的产品面是本地终端，而不是网络 Server。当前没有
HTTP listener、公共 SDK/API 或 WebUI；请勿从内部 workspace 代码推断它们存在。

### 安全使用

- 将 `~/.schemanaut/config.toml` 及其环境变量或安全存储密钥引用视为敏感配置：模型 Endpoint 和
  默认值只能保存在这里，模型密钥不得以明文写入全局或项目设置。项目
  `.schemanaut/settings.json` 只限保存 MCP Server 等项目作用域声明，不能含有模型或 Capability 配置。
- 模型 Endpoint 会收到 prompt 及进入模型上下文的内容。用于敏感代码或数据前，请核验
  Endpoint 身份、传输安全、保留政策和凭据。
- MCP 配置可以启动本地进程（`stdio`），也可以访问远程 Endpoint（`sse`、
  `streamable-http`）。请审查命令、参数、工作目录、URL、环境变量、Header 及其暴露的 Tool；
  已配置不代表可信。
- 项目/工作区和进程 Tool 可以读取文件、写入文件或启动进程。请在全局
  `~/.schemanaut/config.toml` 中选择 `default` 作为不熟悉工作的权限档位，仅在信任的环境中使用
  `auto` 或 `full-access`。全局企业 `allow`/`ask`/`deny` 规则始终有效，项目不能放宽它们。
- 数据库终端配置与命令尚未实现。Capability 前置条件应在 SchemaNaut 项目设置外完成；外部条件缺失时，
  应获得可行动的失败说明，并可在条件变化后重试。
- 本地 Session、Run、Artifact 与状态位于项目 `.schemanaut/` 目录。请按项目的数据保留政策
  保护、备份和删除它；其中可能含有任务历史及本地产物引用。

模型凭据只能通过环境变量或在本机解析的安全引用提供。不要把 Secret 写入仓库、Skill 文件、prompt、
诊断信息、Journal 或漏洞报告。MCP 值同样敏感；请审查其来源并收紧本地文件权限。

Skill 与 MCP Server 不做可信度评分；但其 Tool 与内置 Tool、Capability Tool 共用注册、调用、权限、
批准、审计、取消和恢复边界。

### 报告漏洞

请通过仓库的 **Security → Report a vulnerability** 提交私有 GitHub Security Advisory。在修复
可用前，请勿在公开 Issue 中披露疑似漏洞。

报告请包含受影响版本或提交、复现步骤、影响和可行的缓解方案。请勿提交真实 API Key、数据库
密码、生产数据、项目状态或其他 Secret。

### 支持范围

首个稳定版发布前，安全修复面向 `dev` 最新提交和下一份本地发行产物。
