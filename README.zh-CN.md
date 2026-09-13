# SchemaNaut

![Node.js 22.13+](https://img.shields.io/badge/node-%3E%3D22.13-brightgreen)
![状态：Alpha](https://img.shields.io/badge/status-alpha-orange)
![通用 Agent](https://img.shields.io/badge/Agent-general--purpose-5b5bd6)
![模型中立](https://img.shields.io/badge/model-neutral-0a7f5a)

## 通用 Agent，不必在“什么都能做”和“真正做得专业”之间二选一

> **SchemaNaut 保持一个通用 Agent，在任务需要时让完整的专业 Capability 加入进来。**

它可以阅读和修改代码、运行命令、使用 Git、访问 Web、操作浏览器、处理文档，也可以在同一个任务中查询
数据库、调用本地 Python 分析完整数据、验证结论并生成报告。

它的重点不是“内置更多 Tool”，而是设计了一条让通用 Agent 获得专业能力、又不被专业工具拖垮的路径。

| 14 个基础 Tool | 8 类第一方 Capability | 1 条统一执行主干 | 0 个 Capability 配置中心 |
| ---: | ---: | ---: | ---: |
| 日常能力始终可用 | 专业能力按任务激活 | 权限、结果和恢复不分叉 | 直接复用你已有的环境 |

数据分析是 SchemaNaut 第一个重点打磨的旗舰 Capability，但不是产品边界。它要证明的是：**一个通用 Agent
可以在需要时获得足够深的专业能力，然后继续完成整个任务。**

[English](README.md) · [开始使用](#开始使用) · [用户文档](docs/README.md) · [路线图](docs/product/roadmap.md)

---

## 核心设计：Capability 不是一组换了名字的 Tool

现代 Agent 已经开始使用 Tool Search、Skills 和 MCP 来减少上下文、复用流程和连接外部系统。这些方向是正确的，
SchemaNaut 也全部支持。但它们解决的问题并不相同：

> **Tool Search 回答：“模型现在应该看到哪个 Tool？”**
>
> **Capability 回答：“哪个完整的专业模块，应该基于用户已有的外部环境，加入当前任务？”**

这一区别看起来很小，却旨在帮助 Agent 从“偶尔调用一个专业函数”，走向“使用一套连贯的专业系统”。

| 分层 | 在真实任务中负责什么 |
| --- | --- |
| **基础 Tool** | 立即完成读取、编辑、搜索、执行或消费结果等常用动作 |
| **Tool Search** | 在不预载全部 Schema 的情况下发现相关动作 |
| **Skill** | 为 Agent 推理带入可复用的说明、资源和脚本 |
| **MCP** | 通过开放协议连接外部工具与上下文 |
| **Capability** | 让一个由 Host 管理的完整专业模块加入当前任务 |

~~~mermaid
flowchart LR
    U["用户目标"] --> A["通用 Agent<br/>始终拥有 14 个基础 Tool"]
    A --> D["精简 Capability 目录"]
    D -->|任务选择| P["探测用户已有环境<br/>CLI · 服务 · 文件 · 登录态"]
    P -->|已就绪| G["激活一个完整 Capability Generation"]
    P -->|未就绪| H["说明缺少条件<br/>用户自行准备或让 Agent 协助"]
    H --> P

    G --> C["Tools · Skills · Context<br/>Services · State · Hooks"]
    A --> E["统一执行主干"]
    C --> E
    M["MCP Tools"] --> E

    E --> J["Journal · Result · Artifact<br/>可检查 · 可恢复 · 可交付"]

    classDef core fill:#5b5bd6,color:#fff,stroke:#4141a3,stroke-width:2px;
    classDef cap fill:#0a7f5a,color:#fff,stroke:#075d42,stroke-width:2px;
    classDef result fill:#fff4d6,color:#332b16,stroke:#d3a928;
    class A core;
    class G,C cap;
    class J result;
~~~

### 一次选择，加入完整专业工具集

例如，Claude Code 的 MCP Tool Search 以按需发现单个 MCP Tool 为中心。SchemaNaut 的 Capability 以专业
模块为激活单位：选中 Database 后，与数据库工作有关的完整 Toolset 会一起加入下一轮，而不是让模型在后续
每一步继续寻找、装载和拼凑相关 Tool。

这对真正的专业任务很重要。数据库分析不是一个 query 函数，代码理解也不是一个 diagnostics 函数；完整工作
往往需要一组相互配合的动作、上下文、状态和结果语义。

### 先探测现实世界，再把能力交给模型

Capability 不拥有配置。它在激活时探测用户已经在程序外准备的数据库连接、Git、Forge 登录、容器服务、浏览器
Profile 或语言运行时。

环境已经就绪，Agent 就直接使用；环境缺失，Agent 会得到明确的 unavailable 原因。用户可以自行通过原生 CLI
准备，也可以提供一份说明，让 Agent 用基础工具协助完成。不存在要求用户把同一份连接、凭据和登录状态重新
填写进 Capability JSON 的第二套配置系统。

### 让一段专业工作始终使用一致的能力

相关 Tool、上下文、服务与状态会一起发布。即使 Host 正在为后续工作刷新 Capability，一次模型 Turn 仍然
使用一个完整、一致的能力版本。

<details>
<summary>这一行为背后的 Runtime 保证</summary>

Control Plane 原子发布完整 Generation；正在运行的 Turn 持有不可变 Snapshot 和 Lease，旧 Generation 会等
现有使用者结束后再退出。因此，一个 Turn 不会先看到新 Tool，稍后才得到与它配套的上下文或服务。

</details>

### Capability 增强 Agent，但不成为另一个 Agent

Capability 没有自己的对话循环，也无权决定整个任务何时结束。它只把专业动作和结果交回通用 Agent。

一次 SQL 完成，不代表分析完成；一次浏览器点击完成，也不代表用户目标完成。是否继续验证、组合其他工具、
生成文件或交付结论，仍由同一个通用 Agent 负责。

### 所有能力最终回到同一条执行主干

基础 Tool、Capability Tool、MCP Tool，以及 Skill 激活后使用的 Tool，统一经过：

**prepare → authorize → schedule → execute → observe**

它们共用权限、取消、调度、结果、Journal 和恢复语义。Capability 是专业能力的边界，不是绕过 Runtime 的后门。

## Tool Search、Skill 和 MCP 已经很好，为什么还要增加一层？

并不是因为其他 Agent 没有优秀的工具系统。恰恰相反：

- Claude Code 的 [MCP Tool Search](https://code.claude.com/docs/en/mcp#scale-with-mcp-tool-search) 已经可以延迟
  Tool Schema，并在需要时发现相关工具；
- Codex 的 [Skills](https://openai.com/index/introducing-the-codex-app/) 让任务在相关时使用打包的说明、资源和
  脚本；
- MCP 为工具和上下文集成提供开放协议，Shell 则保留灵活的 Host 侧兜底路径。

每一种抽象都有理由停在自己的边界。Tool Search 不应该顺便拥有每个 Tool 背后系统的生命周期；Skill 应该
保持为可复用指导，而不是变成可执行子系统；MCP Server 应该可以独立部署并保持互操作。少量稳定的文件、搜索、
编辑和 Shell Tool，也已经能覆盖很大范围的工作，不一定需要再增加一层平台。

Capability 分层的成本明显更高。Host 必须负责探测、依赖、原子发布、不可变快照、Lease、刷新、回滚、关闭和
恢复，还要保证它们与权限和结果系统一致。仅仅为了“动态找到一个 Tool”，没有必要建设这些基础设施。

SchemaNaut 选择承担这份复杂度，是因为它的目标不是只做 Coding Agent，而是成为可以不断进入新专业领域的
通用 Agent。进入数据库、浏览器、文档和更深的数据分析后，“有一个 Tool”远远不够；SchemaNaut 需要一个
拥有统一生命周期、可观察状态，并与其余 Runtime 共用恢复语义的专业模块。

所以我们不声称发明了延迟加载。**SchemaNaut 的区别，是把渐进式披露从上下文优化，提升成了专业能力的
Runtime 边界。**

## 第一个旗舰 Capability：完整数据分析

数据分析最能暴露通用 Agent 的现实瓶颈：数据越大，越不应该把全部内容塞进模型上下文。

SchemaNaut 把“模型需要理解什么”和“本地计算需要处理什么”分开：

~~~mermaid
flowchart LR
    Q["自然语言目标"] --> A["通用 Agent"]
    A --> S["Database Capability<br/>理解 Schema · 设计并执行 SQL"]
    S --> R["完整结果引用"]

    R --> P["有界样本<br/>给模型检查与推理"]
    R --> M["完整临时数据<br/>给本地 Python / 进程"]

    P --> V["交叉验证结论"]
    M --> V
    V --> O["解释 · 图表 · 报告 · 代码"]
    R -->|仅在用户明确要求时| F["持久保存原始结果"]

    classDef core fill:#5b5bd6,color:#fff,stroke:#4141a3,stroke-width:2px;
    classDef cap fill:#0a7f5a,color:#fff,stroke:#075d42,stroke-width:2px;
    class A core;
    class S,R cap;
~~~

你可以只给出一个目标：

> 检查这个项目的客户流失数据，找出最重要的风险因素，用可复现的方法验证，并生成一份 Markdown 报告。

同一个 Agent 可以检查仓库和数据库 Schema、编写 SQL、读取必要样本、把完整结果交给本地 Python、运行统计
或简单机器学习分析、复核结论，最后生成交付文件。默认路径把完整结果留在本地 Runtime，由模型通过有界读取
检查证据。Database Capability 也不会把通用任务变成一次孤立的 SQL 对话。

## 这套架构带来的直接优势

| 传统取舍 | SchemaNaut 的选择 | 用户得到什么 |
| --- | --- | --- |
| 只有 Shell：通用，但需要模型反复猜命令 | Shell 常驻，专业工作使用高层 Capability | 减少模型自行拼接和解释底层命令的需要 |
| 所有专业 Tool 首轮加载 | 基础 Tool 常驻，Capability 按任务激活 | 普通任务不持续携带无关 Schema |
| 每个插件拥有自己的配置 | Capability 探测并复用外部环境 | 少一套配置界面，少一份配置漂移 |
| 单个 Tool 各自加载和变化 | 完整 Generation 原子发布，Turn 持有快照 | 一段专业工作使用一致的能力版本 |
| 大结果截断或全部进入上下文 | 有界读取、完整本地物化、显式保存 | 模型负责判断，本地运行时负责完整计算 |
| 专业能力变成独立 Agent | Capability 只增强原通用 Agent | 一个任务可以跨领域连续推进 |
| 中断后从聊天文本猜进度 | Journal 保存 Run、Turn、调用、结果和 Artifact | 长任务可以检查、恢复和继续 |

这不是“工具数量竞赛”。优势在于：**让模型只承担判断，让 Runtime 承担一致性，让 Capability 承担专业性。**

我们不会提前宣称没有数据支持的“更快”或“更省”。[Benchmark 合同](docs/benchmarks/README.md)已经定义如何
在相同模型和任务下比较正确性、时间、Token、Turn、Tool 调用、重试、批准和恢复表现。

## 当前第一方 Capabilities

| Capability | 为通用 Agent 增加的专业能力 | 复用的外部环境 |
| --- | --- | --- |
| **Database** | SQL、Schema 理解、结果引用和完整分析链路 | DATABASE_URL 或受支持的 PG 环境变量 |
| **Git** | 状态、Diff、历史、暂存与提交 | Git CLI 与当前工作区 |
| **Forge** | GitHub/GitLab 仓库工作流 | 已登录的 gh 或 glab CLI |
| **Containers** | 容器检查与执行 | Docker 或 Podman |
| **Browser Automation** | 导航、读取、点击、截图和测试 | 用户通过本机 CDP 准备的专用、已登录 Chrome/Edge Profile |
| **Language Intelligence** | 诊断、格式化和语言级检查 | tsc、ruff、cargo、go 等工具 |
| **Documents** | 文档提取与转换 | pandoc、pdftotext 等原生工具 |
| **Data & Notebook** | 数据集分析与 Notebook 执行 | 本地数据文件和 Jupyter |

一个 Run 可以组合基础 Tool、多个 Capability、Skill 和 MCP。它们是通用 Agent 的杠杆，不是八个互不相干的
小产品。

## 开始使用

SchemaNaut 当前处于 Alpha 阶段，以 `schemanaut` 终端命令作为唯一受支持入口。维护者将 `next` 候选发布到 npm
Registry 后，首先使用以下公共 Alpha 安装方式：

~~~bash
npm install --global @nwlworkshop/schemanaut@next
schemanaut --help
~~~

需要 Node.js 22.13 或更高版本，以及 pnpm 9 或更高版本：

### 从源码运行（开发者和贡献者）

~~~bash
pnpm install
pnpm build:terminal
node apps/terminal/dist/cli.js --help
~~~

全局 ~/.schemanaut/config.toml 只负责模型连接、模型默认值、三档权限和组织规则。项目设置只保存 MCP 声明；
Capability 不增加任何配置段。

~~~toml
version = 1

[agent]
permission_mode = "default"

[[models.connections]]
name = "work"
endpoint = "https://api.siliconflow.cn/v1"
api_key_env = "SILICONFLOW_API_KEY"
~~~

设置对应环境变量，然后初始化项目：

~~~powershell
$env:SILICONFLOW_API_KEY = "替换为你的 Key"
schemanaut init ./my-project
schemanaut chat -C ./my-project
~~~

~~~bash
export SILICONFLOW_API_KEY="替换为你的 Key"
schemanaut init ./my-project
schemanaut chat -C ./my-project
~~~

进入终端后：

~~~text
/config validate
/models
/model 1
分析这个仓库，完成影响最大的改进，并验证结果。
~~~

运行 /doctor 可以检查缺少的全局配置、环境变量、Endpoint、Skill、MCP 或 Capability 外部条件。完整说明请看
[终端指南](docs/guides/terminal.zh-CN.md)和[Capability 指南](docs/guides/capabilities.zh-CN.md)。

## 权限与产品边界

SchemaNaut 只有三种执行模式，并且只由全局 config.toml 和组织规则控制：

- **default**：访问互联网和编辑工作区外文件时需要批准；
- **auto**：只有静态声明的高风险动作和组织规则要求批准；
- **full-access**：内置策略不等待交互批准，但明确的组织规则仍可以批准或拒绝动作。

SchemaNaut 不识别敏感内容，不替用户判断第三方 CLI、Skill、MCP 或 Capability 是否可信。用户负责自己的
输入、模型 Endpoint、外部工具、本地 Journal、Artifact 和第三方输出。浏览器登录态留在执行端，Agent-facing
接口不接收 Cookie、Set-Cookie、API Header 或 Authorization 参数。

当前版本不提供 WebUI、公共 SDK、HTTP Server 或传统数据库 IDE，也不承诺所有平台上的强操作系统沙盒。
准确边界请阅读[安全策略](SECURITY.md)和[诊断与沙盒指南](docs/guides/diagnostics-and-sandbox.zh-CN.md)。

## 深入了解

- [产品概览](docs/product/overview.md)
- [用户文档](docs/README.md)
- [路线图](docs/product/roadmap.md)
- [Benchmark 合同](docs/benchmarks/README.md)
- [参与贡献](CONTRIBUTING.md)
- [Apache-2.0 许可证](LICENSE)
