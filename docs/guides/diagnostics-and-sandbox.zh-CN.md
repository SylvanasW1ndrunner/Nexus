# 诊断与沙盒指南

## 授权档位

授权只来自全局 ~/.schemanaut/config.toml 的档位和组织规则。

| 档位 | 行为 |
| --- | --- |
| default | 互联网访问和工作区外编辑需要批准。 |
| auto | 只有静态声明的高风险动作和组织规则需要批准。 |
| full-access | 动作不会自动被拦截等待批准。 |

项目、Skill、MCP Server 或 Capability 都不能提高这一权限。

## 沙盒执行规则

若配置 require_sandbox，它是全局组织执行规则，不承诺识别敏感信息或保证第三方工具安全。执行 Host
无法提供必需沙盒时报告 unavailable；策略允许用户决定未沙盒执行时报告 ask-unsandboxed。

在没有强操作系统隔离的原生 Windows 上，已批准 root 命令的自然退出可以报告命令退出，但 containment
和完整 process-tree proof 必须是 unverified。取消或终止时，无法证明已停止的 descendant 必须是 unknown。

## 外部状态和输出

请在 SchemaNaut 外修复缺少的命令、文件、服务或登录状态后重试。父进程 PATH 或环境改变后，需要重启
终端 Host。

SchemaNaut 不脱敏诊断、命令输出、Provider 错误或保留结果。它们可以进入 Agent 结果、日志、Journal
和 Artifact，仅受通用大小与生命周期限制。用户决定这些输入和输出是否敏感。不要将真实凭据提交到
Git，这是仓库卫生。

BrowserSession Host Port/浏览器连接器复用用户在 SchemaNaut 外已登录的现有浏览器会话，是面向 Agent API
内容的狭义例外：该产品合同中 Agent 只获得不透明的 browser session/page 引用；schema 不接受 Cookie、API Header
或 Authorization，浏览器协议和会话中的 Cookie/Set-Cookie 字段和值不会进入 prepared intent、结果或 Journal。这不检查或脱敏网页正文、外部
命令输出或用户 browser_test 代码输出。CLI 没有内嵌 Chromium；外部 Playwright 仅作无登录截图/测试后端或用户
维护的测试配置，不保证共享登录态。
