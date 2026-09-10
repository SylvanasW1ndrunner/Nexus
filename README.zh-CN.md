# SchemaNaut

![Node.js 22.13+](https://img.shields.io/badge/node-%3E%3D22.13-brightgreen)

SchemaNaut 是处于 Alpha 阶段、以终端为中心的 Agent 产品。受支持的用户入口是
schemanaut 命令。它在 Agent 使用模型、项目工具、Markdown Skill、已配置 MCP Server 和按任务
需要的可选 Capability 时，持久保存项目级 Session 和 Run。

[English](README.md) · [文档索引](docs/README.md) · [终端指南](docs/guides/terminal.zh-CN.md)

## 从源码检出运行

本地发行工作已经推迟。已有 tarball 和发行脚本只是历史开发产物，不是当前安装入口。请从仓库检出运行：

    pnpm install
    pnpm build:terminal
    node apps/terminal/dist/cli.js --help

Node 22 仍将 node:sqlite 标为实验性模块，但不需要添加实验性 SQLite 启动参数。

## 开始首次对话

创建或选择一个项目：

    schemanaut init ./my-project
    cd ./my-project
    schemanaut chat

请在唯一的全局配置文件 ~/.schemanaut/config.toml 中配置模型连接、模型默认值以及组织范围的权限策略。
模型密钥只能使用环境变量名或安全存储引用，不能写入明文。项目 .schemanaut/settings.json
仅用于项目 MCP 声明。

随后刷新模型目录并选择生成模型：

    &#47;models
    &#47;model 1
    解释这个仓库，并找出最安全的下一项改动。

chat 是默认命令，故 schemanaut -C ./my-project 等价于
schemanaut chat -C ./my-project。模型选择属于 Session，持久项目状态位于
<project>/.schemanaut/。

## 终端提供的能力

- 启动、恢复、取消和压缩持久化的 Agent Run 与 Session。
- 从全局模型连接发现模型，并绑定到当前 Session。
- 加载和调用用户及项目作用域中的 Markdown Skill。
- 使用已配置的 MCP Server，并查看其健康和生命周期状态。
- 应用全局 default、auto 或 full-access 权限策略；组织规则只能进一步收紧动作。

首批可选 Capability 正在本轮开发中。其产品边界是根据用户已在 SchemaNaut 外准备的环境条件按任务
发现，而不是配置模块。Capability 被整合后，Agent 可以说明缺少的前置条件，按用户请求协助完成
外部设置步骤，并在环境改变后重试。请参阅
[Capability 指南](docs/guides/capabilities.zh-CN.md)和[诊断与沙盒指南](docs/guides/diagnostics-and-sandbox.zh-CN.md)。

面对不熟悉的项目，请从 default 开始并审阅每次许可。MCP Server、外部工具和工作区内容仍是本地
信任边界；添加凭据或使用敏感资料前，请先阅读 [SECURITY.md](SECURITY.md)。

SchemaNaut 使用 [Apache-2.0](LICENSE) 许可证。
