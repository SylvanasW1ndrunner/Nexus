# SchemaNaut 终端指南

SchemaNaut 使用 schemanaut 操作。本指南说明终端工作流；它不描述 SDK、HTTP API、Server 或 Web 界面。

## 从源码运行

从仓库检出运行：

    pnpm install
    pnpm build:terminal
    node apps/terminal/dist/cli.js --help

## 创建项目

    schemanaut init ./my-project
    schemanaut chat -C ./my-project

chat 是默认命令。-C 或 --project 指定项目目录；-h 和 --help 输出帮助。skills 命令列出可用 Skill，
sessions 命令列出已保存的 Session。

init 会创建 .schemanaut/AGENT.md、.schemanaut/skills/ 和 artifacts/，但不覆盖已有的起始文件。
项目设置仅用于项目 MCP 声明。

## 配置并选择模型

模型连接、生成默认值和组织范围的权限策略都是全局设置，保存在 ~/.schemanaut/config.toml 中。
模型密钥必须是环境变量名或安全存储引用，不能是明文。

    &#47;models
    &#47;model 1

所选模型属于当前 Session。&#47;model current 显示有效模型信息；/new 会新建隔离 Session，并要求重新选择模型。
项目设置不保存 Endpoint、密钥、模型连接或 Capability 配置。

## 交互命令

运行 schemanaut chat 后输入 /help，即可查看当前命令摘要。

| 命令 | 作用 |
| --- | --- |
| /settings [show\|path\|validate] | 查看、定位或校验项目 MCP 设置。 |
| /config [show\|path\|validate] | 查看、定位或校验脱敏后的全局配置。 |
| &#47;models | 从全局连接刷新模型。 |
| &#47;model [list\|current\|序号\|模型名] | 列出、检查或选择 Session 模型。 |
| /new | 新建未选择模型的隔离 Session。 |
| /resume <session-id> | 恢复 Session 及其模型绑定。 |
| /sessions | 在交互视图中列出 Session。 |
| /run resume <run-id> | 继续已中断或达到限制的 Run。 |
| /skills [list\|reload\|info] | 列出、重新加载或检查 Markdown Skill。 |
| /mcp [list\|start\|stop\|doctor] | 查看或控制已配置的 MCP Server。 |
| /doctor | 检查全局配置、模型、Skill 与 MCP。 |
| /<skill> [任务] | 显式调用已发现的 Skill。 |
| /compact | 请求压缩当前 Run 的上下文。 |
| /cancel | 取消活跃 Run。 |
| /trace on\|off | 显示或隐藏执行轨迹。 |
| /exit 或 /quit | 退出终端。 |

未保留的斜杠命令会被当作 Skill 调用。Run 活跃时，普通文本会成为当前任务的补充要求。

## Session、许可和恢复

Session、Run 和相关状态会持久保存到 <project>/.schemanaut/。Ctrl+C 会取消活跃工作，但保留记录。
Run 中断时，终端会显示 /run resume 命令。执行轨迹是有界活动，不是原始模型推理或完整审计记录。

需要许可时，输入 y 或 yes 批准，输入 n 或 no 拒绝，也可以输入替代要求以拒绝并改变当前任务。
非幂等外部动作结果未知时，使用 s 确认成功、f 确认失败；只有明确接受重试风险时才使用 r。

## 权限与沙盒

全局配置选择 default、auto 或 full-access。项目、Skill、MCP Server 或 Capability 都不能替换该策略。
组织规则即使在 full-access 下也可能要求更严格的决定。批准前，请审阅动作摘要，尤其是外部写入、联网、
凭据、破坏性变更或进程动作。

可用的沙盒取决于主机与具体动作。如果主机无法提供策略要求的隔离，SchemaNaut 会报告这一限制，
而不会声称提供了无法证明的保护。请参阅[诊断与沙盒指南](diagnostics-and-sandbox.zh-CN.md)。

## Skill 与 MCP

项目指令可从 AGENTS.md、CLAUDE.md 和 .schemanaut/AGENT.md 发现。项目 Skill 是
.schemanaut/skills/<name>/SKILL.md 下的 Markdown 文件。

项目设置在 mcp.servers 中声明 MCP Server。stdio Server 需要 command；sse 和 streamable-http
Server 需要 URL。已配置且启用，并标记 autoStart 的 Server 会在交互终端打开时自动启动。使用 /mcp
list、start、stop 和 doctor 查看或控制结果。

请把 MCP 配置视作外部程序或服务。Header 和疑似凭据的环境变量值必须使用安全存储引用；不要把密钥
写入仓库、命令参数、URL 用户信息或查询参数。参见 [SECURITY.md](../../SECURITY.md)。

## 可选 Capability

首批 Capability 正在本轮开发中。其边界使用你已经在 SchemaNaut 外准备好的前置条件，而不是另一个
SchemaNaut 设置界面。Capability 被整合后，请让 Agent 协助任务，在 SchemaNaut 外修复报告的
前置条件后，再搜索或重试。范围和依赖见[Capability 指南](capabilities.zh-CN.md)。
