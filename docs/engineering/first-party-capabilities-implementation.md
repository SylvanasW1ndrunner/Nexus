# 第一方 Capability 实现

本文记录内部实现边界；用户操作方式见 `docs/guides/capabilities*.md`。

## 组合与生命周期

`packages/agent-host/src/bundled-agent-runtime.ts` 是产品组合点。它静态注册八类 manifest，但注册阶段不探测
PATH、网络、数据库或浏览器。`tool_search` 在任务需要时触发 probe/activate；外部状态改变后通过 refresh 发布
新 Tool generation，已捕获的 Turn 继续使用旧 generation 直到释放。

Capability 目录项被选择并成功激活后，其 generation 中的 Tool 在下一 Turn 直接进入模型工具集。模块内部
不再保留“Capability 已激活、但每个 Tool 还要再次 select”的第二层激活状态；Tool schema 预算仍由 Turn
暴露规划器统一限制。

Capability 只负责工具、上下文和单次调用结果，不参与整个 Run 或对话的完成裁决。模块不能注册
Run-level delivery verifier，不能要求自己的 Tool 成为任务最后一次调用，也不能因为后续调用了其他 Tool
而把已经成功的 Capability 结果判为失效。最终回答、继续执行、终止与跨 Tool 编排统一属于 Agent Runtime；
Capability 内部只校验本次调用所需的输入、外部状态、执行结果和结果引用。
所有模型可见结果必须满足公共 `PortableValue` 契约；外部 SDK 或数据库驱动返回的 `Date`、二进制值、
类实例等宿主对象，应在 Capability 边界转换成稳定的文本或结构化值后再交给 Runtime。
对于按只读查询契约执行的 SQL，数据库明确返回的语法、表或字段错误表示本次调用未产生目标变更，
必须投影为可由 Agent 修正的 `invalid_argument/not_applied`，不能升级为需要用户裁决的
`outcome_unknown`；只有无法确认写操作是否已经生效的传输或提交故障才使用未知结果。

一个模块可以发布多个面向任务的 Capability 目录名，但它们可能指向同一个模块实例。`tool_search`
必须按 `{moduleId, instanceId}` 合并激活：同一请求只探测/激活一次，后续请求识别为 already active，
不能因用户或模型同时选择同模块的多个目录名而产生重复 binding 冲突。

命令型模块位于 `packages/first-party-capabilities`，统一使用 Host 提供的 `CapabilityCommandRuntime` 和
`PathExecutableDiscovery`。Capability 自身不导入 `node:child_process`，不接受 shell command 字符串，也不拥有
配置存储。执行文件、工作目录、路径身份、Host 目标、权限事实、截止时间和有界输出都在 Host 边界准备并在
执行前复核。

Database 位于 `packages/database-capability`。bundled Host 注入标准环境 Provider，每次 discovery 从
`DATABASE_URL` 或 PostgreSQL `PG*` 环境重新生成候选；连接材料不是 Agent-facing Capability 配置。
首次激活在发布 Tool generation 前恢复或构建有界 Schema 索引，因此激活后直接暴露的资源检索 Tool
必须立即可用，不要求用户或模型调用隐藏的索引入口。

资源引用不存在或有歧义属于本次 Tool 调用的可修正输入错误。数据库 Tool 可以在当前 binding 上强制刷新
一次 Schema 后重试；仍无法解析时必须返回明确的 `invalid_argument`，不能上报为 outcome unknown、触发
整次 Run 的结果确认或等待用户裁决。

## 模块清单

| 模块 | 主要 Tool | 外部事实 |
| --- | --- | --- |
| Git | status、diff、log、stage、commit、branch | Host 启动 PATH 中的 git 与当前工作区 |
| Database | resource、knowledge、execute、explain | `DATABASE_URL` 或 PostgreSQL `PG*` 环境 |
| Forge | repository/issue/PR 查询与变更 | gh 或 glab 及其外部登录态 |
| Containers | list、inspect、logs、build、run、stop | docker 或 podman 及其 daemon |
| Browser Automation | navigate、read、click、interact、screenshot；可选 test | 本机外部登录的 CDP 会话；可选 Playwright |
| Language Intelligence | diagnostics、format、symbols | 对应语言 CLI |
| Documents | inspect、extract、convert | pandoc、pdftotext 或 pdfinfo |
| Data & Notebook | profile、inspect；可选 run | 原生有界读取；运行需 Jupyter |

## BrowserSession 边界

Browser v1 的 Agent schema 只表达导航、页面引用、selector、交互值和工作区截图路径。Host 连接
`127.0.0.1:9222`，在外部浏览器默认 context 中创建专用页面，因此浏览器网络栈可以复用该 Profile 已有登录态，
Agent 无需接收明文 Cookie、API Header 或 Authorization。连接器不发布 CDP endpoint，不列举或接管用户已有
标签页，也不提供 Cookie、Storage、Network credential 或任意脚本 API。浏览器协议和会话中的 Cookie/Set-Cookie 字段和值不进入 prepared
intent、Tool 结果或 Journal。

这是结构性的 API 隔离，不是内容 DLP：Runtime 不扫描网页正文、外部命令输出或用户维护的 `browser_test`
代码。未来 extension/native bridge 可以替换 CDP 连接器，而不改变 BrowserSession Port 和 Agent-facing Tool
合同。页面导航只做 HTTP(S) 结构校验，不把 URL userinfo 当作需要识别或拦截的敏感内容；本机 CDP
控制端点仍限定为无认证的 loopback URL，因为它属于 Host 控制面而不是页面输入。

## 权限与配置

所有模块都通过同一 prepared intent、PermissionManager、Journal、取消/恢复和结果保留主干。权限只来自全局
`config.toml` 的 `default`、`auto`、`full-access`、企业规则与 `require_sandbox`；Capability、项目、Skill 和
MCP 不能覆盖。项目设置只保存 MCP 声明。

Capability 不实现通用 Secret/credential 内容识别、脱敏或第三方可信度判断。普通外部内容只受结构、大小、
取消和生命周期合同约束，用户负责其敏感性。

## 验证入口

- `pnpm test:capability-runtime`：Control Plane、Tool publication 与 Host 集成。
- `pnpm test:agent-acceptance`：scripted model + 真实 Journal、Artifact、权限、工作区和进程的确定性场景。
- `pnpm test:agent-acceptance:live`：SiliconFlow 真实模型的代码修复、Git/动态 Capability 与
  Database/长结果场景，以及电商经营、SaaS 流失和支付风险三个真实数据分析项目；外部条件缺失
  记录为 not-run，并使 required gate 不合格。数据分析项目的详细合同见
  [真实模型数据分析验收](./real-model-data-analysis-acceptance.md)。
- `pnpm test:script-contracts`：报告格式、退出码、环境变量与旧入口薄封装合同。
