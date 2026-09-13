# 产品概览

SchemaNaut 是一个以终端为入口、模型中立的通用 Agent，面向需要跨代码、Git、数据库、浏览器、文档和
本地数据分析完成真实任务的开发者与数据从业者。

## 核心优势

### 用 Capability 减少模型工作量

每个任务首先获得 14 个稳定的基础 Tool 和一个 Capability 目录。Git、Database、Forge、Containers、
Browser Automation、Language Intelligence、Documents、Data & Notebook 八类第一方 Capability，只在任务
选择后加载完整 Tool Schema。

这种设计把首轮上下文留给任务本身，也减少模型自行猜测 CLI 参数、组合长命令和反复试错的需要。Capability
是专业工具插件，不是配置模块。

### 复用用户已经准备好的环境

Git 配置、数据库连接、Forge 登录、容器服务、浏览器 Profile 和语言工具继续由用户在 SchemaNaut 外用原生
方式管理。Agent 在任务需要时探测状态；缺少条件时说明如何准备，用户也可以要求 Agent 用普通工具协助完成
适合自动化的准备工作，然后重新尝试。

全局 `~/.schemanaut/config.toml` 只保存模型连接、模型默认值、默认权限模式和组织规则；项目 settings 只保存
MCP 声明。Capability 不会要求用户把同一份配置再抄进产品。

### 通用 Agent 与完整数据分析协同

Database Capability 可以把查询结果交给通用结果管线：模型通过 `result_read` 检查有界样本，本地 Python 或
进程通过 `result_materialize` 读取完整临时结果，用户明确要求时再用 `result_save` 持久保存原始结果。
这样可以组合 SQL、Python、文件和解释性回答，而不把完整数据集送入模型上下文。

### 所有动作使用同一执行边界

基础 Tool、Capability Tool、MCP Tool，以及 Skill 激活后由模型调用的 Tool，都经过同一套准备、授权、调度、
执行与观察流程。Skill 文档本身进入模型上下文，不伪装成可执行 Tool。Run、Turn、Tool 活动、结果和 Artifact
进入耐久 Journal，使取消和恢复不依赖一个永不中断的终端进程。

## 适用边界

SchemaNaut 当前只支持 `schemanaut` 终端入口，不提供公共 SDK、HTTP API、Server、WebUI 或图形化数据库 IDE。
它适合已经使用本地 CLI、运行时和服务，并希望让一个 Agent 协同这些工具的用户；不适合需要托管式零配置服务、
自动敏感信息识别、第三方工具可信度评分或所有平台强 OS 沙盒的场景。

## 权限与责任

权限只由全局 `config.toml` 中的 `default`、`auto`、`full-access` 和组织规则决定。SchemaNaut 不扫描内容以
识别敏感信息，也不判断第三方 CLI、Skill、MCP 或 Capability 是否可信。用户负责输入、模型 Endpoint、外部
工具、Journal、Artifact 和第三方输出。

Browser Automation v1 复用用户在专用 Chrome/Edge 远程调试 Profile 中建立的登录态。面向 Agent 的 Schema
不接受 Cookie、`Set-Cookie`、API Header 或 Authorization 值；该狭义接口隔离不等同于网页正文、命令输出或
测试代码的内容扫描。

继续阅读：[终端指南](../guides/terminal.zh-CN.md)、[Capability 指南](../guides/capabilities.zh-CN.md)、
[诊断与沙盒指南](../guides/diagnostics-and-sandbox.zh-CN.md)和[Benchmark 合同](../benchmarks/README.md)。
