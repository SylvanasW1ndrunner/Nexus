# SchemaNaut

![Node.js 22.13+](https://img.shields.io/badge/node-%3E%3D22.13-brightgreen)

SchemaNaut 是处于 Alpha 阶段、以终端为中心的 Agent 产品。受支持的用户入口是 schemanaut 命令。

[English](README.md) · [文档索引](docs/README.md) · [终端指南](docs/guides/terminal.zh-CN.md)

## 从源码检出运行

    pnpm install
    pnpm build:terminal
    node apps/terminal/dist/cli.js --help

## 开始首次对话

    node apps/terminal/dist/cli.js init ./my-project
    node apps/terminal/dist/cli.js chat -C ./my-project

请在全局 ~/.schemanaut/config.toml 中配置模型连接、模型默认值和组织规则。项目
.schemanaut/settings.json 只用于项目 MCP 声明。

    /models
    /model 1
    解释这个仓库，并找出最安全的下一项改动。

## 授权与责任

SchemaNaut 只有一种授权机制：全局 default、auto 和 full-access 三档，加上 config.toml 中的组织规则。
default 下，互联网访问和工作区外编辑需要批准；auto 下，只有静态声明的高风险动作和组织规则需要批准；
full-access 不会自动拦截动作等待批准。

SchemaNaut 不承担敏感信息识别、Secret 脱敏、类似凭据参数拦截、第三方 CLI、Skill、MCP Server 或
Capability 可信度判断，也不负责使外部输出安全。用户负责输入、工具配置、模型 Endpoint、日志、
Journal、Artifact 和第三方输出的敏感性。

狭义 API 隔离针对 BrowserSession Host Port/浏览器连接器：它复用用户现有浏览器登录态，但面向 Agent 的
schema 不接受 Cookie、API Header 或 Authorization。该产品合同中 Agent 只获得不透明的 browser session/page
引用；Cookie 和 Set-Cookie 不会进入 prepared intent、结果或
Journal。这不是扫描或脱敏网页正文、外部命令输出或用户 browser_test 代码输出。SchemaNaut 没有内嵌 Chromium。
外部 Playwright 仅作无登录截图/测试后端或用户自行维护的测试配置，不保证共享登录态。基础 web_fetch 无状态；
web_search API 凭据仍只允许 HTTPS。

首批可选 Capability 正在本轮开发中。它们是按任务发现的增强，不是配置模块。请参阅
[Capability 指南](docs/guides/capabilities.zh-CN.md)和[诊断与沙盒指南](docs/guides/diagnostics-and-sandbox.zh-CN.md)。

仓库卫生仍然重要：不要把真实凭据提交到 Git。SchemaNaut 使用 [Apache-2.0](LICENSE) 许可证。
