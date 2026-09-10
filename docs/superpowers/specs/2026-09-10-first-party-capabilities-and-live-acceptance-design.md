# 第一批内置 Capability 与真实 Agent 验收设计

> 状态：已批准，进入实现
> 日期：2026-09-10
> 适用范围：用户文档、内置 Capability、私有 Agent Host、统一验收脚本

## 1. 目标

本轮把已经完成的通用 Agent 基础工具扩展为一套真正可用的产品组合：

1. 用户文档只解释产品能做什么、如何使用、如何诊断；内部架构、代码地图、实现记录和测试证据放在独立开发文档中。
2. 交付第一批八类内置 Capability：Git、Database、Forge、Containers、Browser Automation、Language Intelligence、Documents、Data & Notebook。
3. Capability 不提供 SchemaNaut 内部配置表单、项目 JSON 或专属设置 API。它直接探测用户已经在产品外准备好的 CLI、文件、环境变量、登录状态或服务；失败时告诉 Agent 缺什么、在外部如何修复、修复后如何重试。
4. 用确定性集成测试和真实 SiliconFlow 模型测试证明基础 Tool、动态 Capability、权限、取消、恢复、长结果与交付证据可以在实际任务中协同。

## 2. 非目标

- 不实现 Capability 管理 UI、市场、公开 SDK 或第三方 ABI。
- 不把 Capability 配置加入项目 settings、全局 `config.toml` 或内部数据库。
- 不把 Database 重新提升为产品主线或基础 Tool。
- 不在本轮自研跨平台 OS 沙盒；只冻结 Host 执行端口，使未来沙盒实现可以替换。
- 不为了兼容旧命令、旧字段或旧包结构保留重复路径。
- 不推进安装器、本地发行或 Registry 发布。

## 3. 文档受众边界

### 3.1 用户文档

用户入口只包含：

- 根 `README.md`、`README.zh-CN.md`
- `docs/README.md`
- `docs/product/overview.md`
- `docs/product/roadmap.md`
- `docs/guides/terminal.md`、`docs/guides/terminal.zh-CN.md`
- Capability 与诊断用户指南
- `SECURITY.md`

这些文档使用用户语言，不解释 Registry、generation、lease、内部包依赖或历史测试通过数。它们只承诺当前产品行为和明确的未来方向。

### 3.2 开发文档

`docs/engineering/README.md` 是唯一开发入口，并索引：

- `docs/architecture/`：规范性运行时合同
- `docs/engineering/`：代码地图、实现约束、测试策略与实现记录
- `docs/capabilities/`：各内置 Capability 的内部设计与数据边界
- `docs/superpowers/specs/` 与 `docs/superpowers/plans/`：批准设计和执行计划

Capability 作者指南属于开发文档，不属于用户手册。历史问题审计必须明确标记为历史基线，不得描述当前产品状态。

## 4. Capability 产品合同

Capability 是由 Host 注册、由 Agent 按任务发现并激活的增强 Tool 集。它不是配置对象，也不是第二个 Agent。

每个内置 Capability 必须满足：

1. **静态注册、延迟激活**：默认产品组合注册模块 manifest，但首轮不把其完整 Tool schema 全部发送给模型；Agent 通过 `tool_search` 发现并激活。
2. **外部状态即事实**：probe 只观察当前环境，不读取 SchemaNaut 专属 Capability 配置；外部状态改变后再次 probe，暂时失败不永久缓存。
3. **可行动失败**：不可用结果至少说明缺失依赖、受影响能力、外部修复方式和重试动作；原因遵守通用大小和生命周期约束。用户负责外部诊断与输出的敏感性。
4. **帮助不是配置面**：Agent 可以使用基础 Tool 执行用户要求的外部配置步骤；Capability 可提供帮助 Tool，但不得保存一份 SchemaNaut 所有的“已配置”状态。
5. **统一执行主干**：所有贡献 Tool 都经过 `prepare → authorize → schedule → execute → observe`，使用 Runtime 的权限、批准、审计、取消、结果保留和恢复合同。
6. **不可变 generation**：激活或刷新产生完整新 generation；同一 Turn 不混用新旧 Tool；旧 generation 在 lease 排空后关闭。
7. **Host 拥有执行设施**：Capability 不直接调用 `child_process`。命令型 Capability 使用 Host 提供的受控 argv 执行端口；浏览器、数据库等专用 I/O 同样只能经显式 Host Port。

用户只看到“当前任务可用 / 缺少前置条件 / 需要选择外部上下文 / 执行失败并可重试”，不会看到 Control Plane 生命周期状态。

## 5. 受控命令执行基础

`core-tools` 提供内部 `CapabilityCommandRuntime`，复用同一个 `ProcessRuntime` 和 `SandboxExecutor`：

- 命令型 Capability 以 `executable + argv[]` 提交，不拼接 shell 字符串；基础 `process_exec` 仍可接受用户 shell 命令。
- prepare 固定可执行文件、参数、cwd、路径、主机、网络、写入、破坏性、管理员和未知风险等静态操作事实；不扫描参数识别凭据或 Secret。
- execute 必须复核已准备目标、全局权限 revision 与执行边界，并把取消和 deadline 传入进程运行时。
- 输出使用普通有界 spool 与 Runtime retention；模型接收的内容遵守通用大小和生命周期约束。
- 外部命令继承用户环境；Runtime 不进行 CommandRedactor、CommandArgumentGuard、凭据参数拒绝或输出脱敏。
- 不进行任何通用 Secret/credential 内容识别、拦截或脱敏。唯一狭义 API 隔离是未来 BrowserSession Host Port/
  浏览器连接器复用现有浏览器登录态时，Agent-facing schema 不接受 Cookie、API Header 或 Authorization，且
  Cookie/Set-Cookie 不进入 prepared intent、结果或 Journal；它不扫描网页正文、外部命令输出或用户 browser_test
  代码输出。基础 web_fetch 无状态，web_search API 凭据 HTTPS-only。
- 外部文件或登录状态改变后可重新 probe；父进程 PATH 或环境改变时必须重启 Host 才能继承新状态。
- 原生 Windows 无强 OS 隔离时，批准后的自然 root exit 可以报告命令退出，但 containment 和完整 process-tree proof 必须标为 unverified；取消或终止时，无法证明停止的 descendant 仍为 unknown。本轮不引入 Job Object。
- 默认 `NativeSandboxExecutor` 明确表示“无 OS 隔离”。当策略要求强沙盒而 Host 无法提供时返回 `unavailable`；其他情况按策略产生 `ask-unsandboxed`，不得称为已沙盒化。

平台差异只留在 Host 执行器和可执行文件发现器中。PATH 发现返回经过校验的 launch descriptor；Windows npm .cmd 必须安全解析为 node 加 entry script，禁止 shell fallback。Capability 的 TypeScript 代码不得依赖 PowerShell、cmd.exe、POSIX shell 语法或平台路径常量。

## 6. 第一批 Capability 清单

所有 Tool 名称是 v1 产品合同。只读工具与写入工具必须分别声明权限事实，不能用模块级统一危险等级替代逐调用分类。

### 6.1 Git — `schemanaut.git`

外部事实：PATH 中可执行的 `git`，以及调用时工作区是否属于 Git 仓库。

Tool：

- `git_status`：结构化工作树、分支与上游状态
- `git_diff`：工作树或 staged 差异，可限制路径和上下文
- `git_log`：有界提交历史
- `git_show`：查看单个 ref/对象的有界内容
- `git_stage`：按明确路径更新 index
- `git_commit`：以明确消息创建一次提交

读取为本地只读；stage 是工作区写入；commit 是非幂等风险操作。任何 remote 操作留给 Forge 或基础 `process_exec`，不在 Git v1 隐式联网。

### 6.2 Database — `schemanaut.database`

沿用现有 `resource_list`、`resource_get`、`knowledge_search`、`sql_execute`、`sql_explain`。新增标准外部环境 Provider：发现 `DATABASE_URL` 或 PostgreSQL 标准环境变量。连接值、候选信息和外部输出遵守普通大小与生命周期合同；用户负责其敏感性。

没有外部连接时模块仍可被发现，但返回缺少连接环境的可行动诊断。多候选必须由 Runtime 签发的 choice reference 选择，不能由模型提交原始连接信息。

### 6.3 Forge — `schemanaut.forge`

外部事实：PATH 中的 `gh` 或 `glab`；认证和当前仓库绑定由相应 CLI 自己维护。若两者都可用，probe 返回外部上下文选择。

Tool：

- `forge_status`
- `forge_issue_list`
- `forge_issue_view`
- `forge_pr_list`
- `forge_pr_view`
- `forge_checks`
- `forge_pr_create`

读取工具声明联网；`forge_pr_create` 是非幂等外部写入并需要风险批准。外部 CLI 的登录状态、profile 和输出由用户负责。

### 6.4 Containers — `schemanaut.containers`

外部事实：PATH 中的 `docker` 或 `podman`。若两者都存在，使用 Runtime 外部上下文选择；不得自动触碰 socket 来完成 probe。

Tool：

- `container_list`
- `container_inspect`
- `container_logs`
- `container_exec`
- `container_compose`

容器 daemon/socket 具有高权限含义；即使是读取也必须在 permission facts 中标记该边界。`exec` 与 `compose` 为高风险非幂等执行。Capability 不声称外层沙盒可以约束一个已获宿主机控制权的容器 socket。

### 6.5 Browser Automation — `schemanaut.browser`

浏览器 test 是高风险代码执行；不得仅按声明路径描述其影响。

外部事实：未来 BrowserSession Host Port/浏览器连接器复用用户已有浏览器登录态。当前 CLI 没有内嵌 Chromium；
外部 `playwright` CLI 仅作无登录截图/测试后端或用户自行维护的测试配置，本轮不自动下载浏览器，也不保证共享
登录态或提供 Cookie/API Header/Authorization 参数。

Tool：

- `browser_screenshot`
- `browser_pdf`
- `browser_test`

前两个使用明确 URL 与工作区输出路径；`browser_test` 只运行工作区内明确测试文件。浏览器访问声明联网，输出文件声明写入；执行任意浏览器测试属于高风险代码执行。不存在可证明浏览器隔离时，不得称其处于 Sandbox。

### 6.6 Language Intelligence — `schemanaut.language`

每个 Language backend 的风险必须逐项声明：例如 cargo check 可能执行 build script，format 会改写文件，不能笼统声称只读。

外部事实：从项目标记与 PATH 发现 `tsc`、`pyright`、`ruff`、`cargo`、`go` 或 `ctags` 等已安装工具。模块可处于 degraded：只贡献当前环境能可靠执行的子能力，同时为缺失子能力返回诊断。

Tool：

- `language_diagnostics`
- `language_symbols`
- `language_format`

diagnostics/symbols 默认只读；format 是工作区写入。v1 不实现常驻 LSP 进程或自有语言服务器管理器，后续可在不改变 Tool 权限与结果合同的情况下替换 backend。

### 6.7 Documents — `schemanaut.documents`

外部事实：按操作发现 `pandoc`、`pdftotext`、`pdfinfo`。模块可 degraded；不自动安装工具。

Tool：

- `document_metadata`
- `document_extract`
- `document_convert`

输入、输出必须是准备后固定的文件路径。读取不写文件；转换只写明确目标，不覆盖未确认的现有文件。外部 CLI 输出按长结果合同保留。

### 6.8 Data & Notebook — `schemanaut.data-notebook`

notebook_run 属于任意代码执行和非幂等高风险操作；不得仅按声明路径描述其影响，且批准前不得创建输出。

基础 JSON/JSONL/CSV 与 `.ipynb` 检查由内置 TypeScript backend 提供；执行 notebook 时再探测 PATH 中的 `jupyter`。

Tool：

- `data_profile`
- `notebook_inspect`
- `notebook_run`

profile/inspect 只读且有行数、字节、列数和嵌套深度上限。`notebook_run` 只接受工作区输入/输出路径，属于任意代码执行和非幂等高风险操作；缺少 Jupyter 时返回可行动诊断，不影响前两个 Tool。

## 7. 默认加载与刷新

`createBundledAgentRuntime()` 是终端产品组合入口：

1. 创建或复用一个 Host-owned `ProcessRuntime`。
2. 创建通用 Agent Runtime 和受限 Host services。
3. 注册八类内置 Capability；注册本身不运行外部命令、不开网络、不连接数据库。
4. 第一 Turn 捕获静态 discovery manifest；模型需要专业能力时通过 `tool_search` 激活。
5. 外部状态修复后，下一次显式搜索/重试重新 probe；失败不成为永久禁用状态。

`new AgentRuntime()` 继续保留为无默认专业 Capability 的内部测试/组合入口。终端只使用 bundled 工厂。

## 8. 权限和风险映射

每次 Tool prepare 接收并固定 Run policy mode/revision；ProcessRuntime 以该快照准备，execute 复核同一边界。全局配置还需向 Runtime 同步 require_sandbox 等企业要求。

权限只来自全局 `~/.schemanaut/config.toml`，项目、Skill、MCP 和 Capability 都不能覆盖。

- `default`：工作区内普通读写可自动执行；外部写入、联网和风险动作询问。
- `auto`：仅静态声明的高风险、破坏性、管理员、未知风险或企业策略要求的动作询问。
- `full-access`：内置逐次批准可以取消，但企业 `deny/ask`、目标校验、审计、取消与恢复仍生效。

Tool 的 prepared intent 必须描述实际目标。批准前零副作用；批准后同一 action 最多提交一次。外部配置帮助也遵守同一规则。

## 9. 统一验收

### 9.1 每次开发都运行的确定性场景

使用 scripted/fake model，但保留真实 Journal、Artifact、权限、工作区与本地进程：

1. `base.workspace-process-repair`
2. `cap.deferred-search-load`
3. `cap.git-workflow`
4. `cap.database-missing-and-query`
5. `cap.forge-provider-choice`
6. `cap.container-risk-gate`
7. `cap.browser-artifact`
8. `cap.language-diagnostics-format`
9. `cap.documents-extract-convert`
10. `cap.data-notebook-profile-run`
11. `cap.cancel-recover`
12. `cap.large-result-retention`

断言依据是磁盘、进程退出、独立数据库查询、Artifact digest/page、Journal 事件和 Runtime evidence，不比较模型的固定措辞或推理步骤。

### 9.2 真实环境层

真实模型默认使用 SiliconFlow OpenAI-compatible Endpoint 与 `deepseek-ai/DeepSeek-V4-Flash`。只从进程环境读取：

- `TEST_SILICONFLOW_API_KEY`
- `TEST_SILICONFLOW_BASE_URL`
- `TEST_SILICONFLOW_MODEL`

脚本不自动读取产品配置或 `.env`，不接受命令行 key。key 从当前进程环境传给 Provider 是测试接线事实；真实验收关注功能后置条件，而不提供产品级输出安全治理。

真实模型最少执行三个高价值任务：基础代码修复、Git/动态 Capability 协作、Database/长结果证据协作。已安装的其他外部依赖按场景运行；缺少依赖必须记为 `not-run` 而不是 pass。显式 required live gate 中，任何 required 场景 not-run 都使验收不合格。

子进程 stdout/stderr、Provider 错误和报告遵守普通大小与生命周期约束。报告区分 `passed`、`failed`、`not-run`，并记录环境缺口；用户负责这些外部内容的敏感性。

## 10. 完成标准

- 用户与开发文档入口分离，用户页面不再含旧 `/mode`、旧 MCP 行为、“基础 Tool 尚未实现”或 Control Plane 内部操作说明。
- 八类模块均由 bundled Host 注册、可被 `tool_search` 发现，并按外部事实激活或返回可行动诊断。
- 命令型 Capability 全部使用 argv Host Port，没有模块直接导入 `node:child_process`。
- Capability 没有新增项目/global 配置字段；外部内容遵守普通大小、取消和生命周期合同。
- 默认确定性验收、构建、类型检查、lint、完整测试通过。
- 真实 SiliconFlow 场景实际执行并产生功能报告；任何未运行场景明确列出原因。
- 最终架构扫描确认所有扩展 Tool 共用统一权限、审计、取消、恢复与结果主干。
