# Capability、Tool、Skill 与 MCP 合同

本文是开发者文档，定义稳定内部合同。

## 统一动作边界

Tool 是唯一可执行动作合同。Capability 与 MCP 把动作注册为 Tool；Skill 文档通过基础 `skill` Tool 激活后进入
模型上下文，再由模型调用可用 Tool；子 Agent 通过委派 Tool 启动。基础 Tool、Capability Tool、MCP Tool 与
Skill 激活后调用的 Tool 都经过 prepare、authorize、schedule、execute、observe 主干，使用同一份全局权限
模式、组织规则、取消、恢复和结果生命周期。

Capability 是由 Host 注册、按任务发现和激活的专业 Tool 集，不是第二个 Agent 循环，也不是项目或程序内
配置对象。Capability 只静态声明操作事实，例如工作区写入、联网、外部写入、破坏性和高风险。它不扫描
用户内容、参数或输出来判断 Secret、凭据或可信度。

## 配置、权限和执行

全局 config.toml 只承载模型连接、模型默认值和企业权限。项目 settings 只承载 MCP 声明。default 对
互联网和工作区外编辑要求批准；auto 只对静态高风险动作及企业规则要求批准；full-access 不自动拦截
动作等待批准。require_sandbox 若存在，只是全局企业执行规则。

命令型 Capability 使用 Host-owned ProcessRuntime 或 SandboxExecutor 的 argv Port。命令和输出可进入
结果与 retention，仅受通用大小、取消和生命周期约束；Runtime 不进行 CommandRedactor、
CommandArgumentGuard、凭据参数拦截或外部输出安全治理。

## 生命周期

Host 注册静态 manifest。Capability Control Plane 管理探测、激活、刷新、发布和关闭。一个 Turn 捕获
完整、不可变的贡献快照并持有 lease；刷新发布完整新 generation，旧 generation 在已有 lease 排空后
关闭。外部 CLI、文件、登录或服务改变后可以重新 probe；父进程 PATH 或环境改变需要重启 Host。

MCP 配置属于项目范围的外部程序或服务声明。SchemaNaut 不判断其可信度；用户负责第三方工具、MCP、
Skill 和 Capability 的配置与输出敏感性。
