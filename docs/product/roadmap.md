# SchemaNaut 路线图

本路线图描述面向用户的方向，不构成公共 API 或安装承诺。

## 当前产品边界

- schemanaut 是受支持的用户入口。
- 全局 config.toml 是模型默认值、权限档位和组织规则的唯一来源；项目设置只保存 MCP 声明。
- 首批开发中的 Capability 包括 Git、Database、Forge、Containers、Browser Automation、Language Intelligence、
  Documents 和 Data & Notebook；它们按任务使用，不是项目配置或启动前提。
- 产品授权仅由 default、auto、full-access 和组织规则决定；它不承担内容敏感性识别或第三方信任判断。
- 唯一狭义 API 隔离是内置 HTTP/browser bridge 不将 Cookie/Set-Cookie 值放入 Agent-facing schema、prepared
  intent、结果或 Journal；这不扫描网页正文、外部命令输出或用户 browser_test 代码输出。Browser Capability
  使用外部准备的浏览器/Playwright 环境和登录态；当前 CLI 没有内嵌 Chromium，也不提供 Cookie 参数。

## 近期方向

完善可选能力的任务发现、外部状态重试、全局权限与可解释的动作摘要。可选能力整合后，缺少某项外部
条件不应阻止通用 Agent、Skill 或 MCP 的基础工作流。

## 用户责任

用户负责外部工具、模型 Endpoint、输入、日志、Journal、Artifact 和第三方输出的敏感性。仓库文档
会继续建议不要把真实凭据提交到 Git，这是仓库卫生而非产品级脱敏。
