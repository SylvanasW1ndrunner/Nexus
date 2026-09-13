# 通用 Agent 基础工具实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 按冻结设计完成 12 个固定基础 Tool、统一 prepared invocation、结果续读、全局权限和协调/扩展 Tool 迁移，使所有 Agent 获得一致且可恢复的基础操作面。

**架构：** 保留现有不可变 Turn catalog、handler generation、Journal 和 Capability Control Plane。先在 `core-agent` 建立 `prepare → authorize → schedule → execute → observe` 的共享合同及 Runtime-only 引用，再由 `core-tools` 实现 Workspace、Process、Web、交互和协调工具，最后由私有 Host 固定组合并由 Terminal 呈现。旧名称和旧参数不保留兼容层。

**技术栈：** TypeScript、Node.js、AJV/JSON Schema、SQLite Journal、Vitest、ripgrep adapter、私有 Terminal Host。

**Spec：** `docs/architecture/base-tools-design.md`

## 全局约束

- 12 个基础 Tool 的名称和顺序固定为：`ask_user`、`tool_search`、`result_read`、`skill`、`workspace_list`、`workspace_read`、`workspace_search`、`workspace_apply_patch`、`process_exec`、`process_control`、`web_search`、`web_fetch`。
- 基础 Tool 始终为 `direct`，不受 schema 预算、Run `allowedTools`、Skill 或扩展激活影响；旧 `pinnedTools` 名称预加载入口删除；后端缺失时返回结构化 `unavailable`。
- `task_plan_create`、`task_update`、`task_list` 和 `subagent_*` 为 deferred 协调 Tool；Capability/MCP Tool 按需发现。
- 权限模式只来自全局 `~/.schemanaut/config.toml`；删除 Run/项目级权限覆盖与模型可见 `config_read`。
- Capability 不拥有程序内或项目内配置；MCP、Skill、Capability 和固定 Tool 不按来源获得旁路或可信度评分。
- handler 只返回受约束 payload；Observation、contentRef、evidenceRef、审计和 terminal status 由 Runtime 生成。
- `access`/`concurrency` 驱动权限与调度，`recoveryClass` 单独驱动恢复；write 保持 action ordinal 串行。
- 本轮不采用测试驱动：先按代码和合同完成实现，再在最后统一修改、补齐并运行测试。
- 当前 `dev` 工作树包含上一阶段尚未提交的架构改动；仅修改本计划涉及文件，不回退、清理或覆盖无关变更。

---

### Task 1：prepared Tool 协议、Registry 校验与固定 manifest

**文件：**

- 新增：`packages/core-agent/src/tools/tool-protocol.ts`
- 新增：`packages/core-agent/src/base-tool-manifest.ts`
- 修改：`packages/core-agent/src/types.ts`
- 修改：`packages/core-agent/src/tool-registry.ts`
- 修改：`packages/core-agent/src/tool-exposure-planner.ts`
- 修改：`packages/core-agent/src/index.ts`

**接口：**

- 产出 `ToolAccess`、`ToolRecoveryClass`、`InvocationLimits`、`PreparedToolIntent<T>`、`ToolPrepareContext`、`ToolExecuteContext`。
- `ToolInvocationHandlerRuntime` 产出 `prepare(input, context)` 与 `execute(prepared, context)`；Registry 固定 `toolRevision`、`handlerRevision`、`intentRevision`。
- baseline manifest 固定 12 个 Tool 的名称、顺序和 schema revision，并提供 `isBaseToolName()`。

- [x] 定义可序列化 prepared intent、target identity、动态权限事实、资源键、limits 和 action summary；所有边界值使用明确上限。
- [x] 将 `effect` 迁为 `recoveryClass`，将 `execution.concurrency` 与 `access` 分离；删除执行期 `resolveEffect`，把动态权限解析迁入 `prepare`。
- [x] 扩充 Registry 发布前校验：descriptor/schema 大小、access/readonly/concurrency/recovery 一致性、limits 完整性和 handler revision 可解析性。
- [x] 让 exposure planner 单独保留 baseline，按 manifest 顺序输出，预算只作用于 deferred/扩展 Tool。

### Task 2：Journal prepared facts、权限与资源调度

**文件：**

- 修改：`packages/core-agent/src/events/agent-event.ts`
- 修改：`packages/core-agent/src/events/agent-journal.ts`
- 修改：`packages/core-agent/src/events/event-projectors.ts`
- 修改：`packages/core-agent/src/events/event-schema-registry.ts`
- 修改：`packages/core-agent/src/events/sqlite-agent-journal.ts`
- 修改：`packages/core-agent/src/tools/tool-scheduler.ts`
- 修改：`packages/core-agent/src/tools/tool-invocation-runtime.ts`
- 修改：`packages/core-agent/src/permission-manager.ts`

**接口：**

- `tool.prepared`（或等价 validated payload）持久化完整 intent 与 digest；approval/start/terminal 引用同一 digest。
- scheduler 输入包含 `access`、`recoveryClass`、`concurrency`、`resourceKeys`，输出实际执行窗口。

- [x] 在校验原始模型输入后调用 `prepare`，先提交不可变 intent，再进行权限决策；恢复只读取 intent，不重新解析原参数。
- [x] 权限只评估 intent 内 facts；批准后执行前建立 resource lease 并复核 target/boundary，变化时返回 `target_changed`/`conflict`。
- [x] scheduler 只并行连续、资源不冲突的 read；write 串行，exclusive 独占；实际分类和资源键进入 Journal。
- [x] 拆分 Invocation Runtime 的 prepare、authorize、lease/revalidate、execute、result 和 recovery 协作者，保持现有原子 terminal/observation 提交不变量。
- [x] 增加 `prepared`、`waiting_for_user`、`timed_out`、`unsupported_revision` 等设计终态/非终态映射，并保持每次 Invocation 唯一终态。

### Task 3：Runtime Observation、contentRef、evidence 与 `result_read`

**文件：**

- 修改：`packages/core-agent/src/artifacts/artifact-store.ts`
- 修改：`packages/core-agent/src/artifacts/project-artifact-store.ts`
- 新增：`packages/core-agent/src/artifacts/content-reference.ts`
- 修改：`packages/core-agent/src/tool-result.ts`
- 修改：`packages/core-agent/src/evidence-reference.ts`
- 修改：`packages/core-agent/src/delivery/delivery-verifier.ts`
- 新增：`packages/core-tools/src/result-tools.ts`
- 修改：`packages/core-tools/src/index.ts`

**接口：**

- `ToolObservation = {status, summary, preview?, contentRef?, contentType?, totalBytes?, truncated, nextCursor?, provenance}`。
- content owner 至少包含 host/session/run/invocation，可选 project；Runtime 提供 text/line/record/byte cursor read。

- [x] 为 artifact 建 owner index、ACL、expiry、pin、active-run retention 和 GC；projectless Run 仍可读取本 Run 内容。
- [x] Runtime 接收 handler payload、进行输出 schema/大小校验、保存超预算正文并生成稳定 preview/contentRef；外部 envelope 不能伪装内部结果。
- [x] Runtime 独占 evidenceRef 签发，Delivery verifier 校验引用所有权、存在性、revision 和生命周期。
- [x] 实现固定基础 Tool `result_read`，校验 cursor 类型、范围、UTF-8 边界、EOF、越权、过期和不存在错误。

### Task 4：全局权限来源、固定 Host 组合与 `ask_user`

**文件：**

- 修改：`packages/agent-host/src/types.ts`
- 修改：`packages/agent-host/src/agent-runtime.ts`
- 修改：`packages/agent-host/src/global-config.ts`
- 删除：`packages/agent-host/src/global-config-tools.ts`
- 新增：`packages/core-tools/src/interaction-tools.ts`
- 修改：`packages/core-agent/src/kernel/runtime-command.ts`
- 修改：`packages/core-agent/src/kernel/run-controller.ts`
- 修改：`apps/terminal/src/interactive-cli.ts`

- [x] 从 `AgentRunInput`、请求 digest、Run ingress 和 Terminal `/mode` 删除权限覆盖；每次新 Run 使用当前全局模式，企业规则可对恢复中的 Run 收紧。
- [x] 删除 `config_read` 模型 Tool，保留 Host `/config` 的 secret-safe 用户视图。
- [x] Host 按 baseline manifest 只注册一次固定 contribution；后端 slot 缺失时保留 schema/顺序并返回 `unavailable`，后端更新发布新 generation。
- [x] 实现 `ask_user` 的 1–3 个有界问题、durable question revision/idempotency、`waiting_for_input` barrier、答复 runtime command、取消/超时和非交互 unavailable。

### Task 5：Workspace 四工具

**文件：**

- 重构：`packages/core-tools/src/workspace-tools.ts`
- 新增：`packages/core-tools/src/workspace-search-rg-adapter.ts`

- [x] `workspace_list` 使用有界迭代、稳定排序和 cursor，实际枚举量受限并检查 signal。
- [x] `workspace_read` 读取请求范围而非整文件，返回 canonical identity、digest、mtime、总量和 contentRef。
- [x] `workspace_search` 通过 ripgrep adapter 统一 ignore/glob/regex/literal/binary/Unicode，并限制文件、字节、时间和结果。
- [x] 删除 `workspace_write/edit/patch`，实现 `workspace_apply_patch(create|update|delete)`；update/delete 强制 `expectedDigest`，条件写与权限目标使用同一 prepared identity。

### Task 6：Process 两工具与 SandboxExecutor

**文件：**

- 重构：`packages/core-tools/src/process-tools.ts`
- 重构：`packages/core-tools/src/process-runtime.ts`
- 新增：`packages/core-tools/src/sandbox-executor.ts`

- [x] `process_exec` direct 注册；prepare 固定 cwd、命令 facts、host/executor/boundary revision、requested capabilities 和确定性 sandbox decision。
- [x] 继承用户外部环境，仅按全局企业规则删除/限制变量与命令；不得为 CLI 再建程序内配置。
- [x] 合并 poll/write/terminate 为 `process_control` 条件 schema；统一 signal、timeout、stdin 上限和稳定错误码。
- [x] 为并发进程、单进程/Run spool、运行/空闲时间建立配额；cursor 保持 UTF-8 边界，spool 可通过 contentRef 续读。
- [x] Host 重启把无法绑定的 live process 标为 orphaned；进程树或 spool 结果不确定时不报告虚假成功。

### Task 7：Web 两工具与安全传输边界

**文件：**

- 重构：`packages/core-tools/src/web-tools.ts`
- 新增：`packages/core-tools/src/secure-web-transport.ts`

- [x] Web 后端存在与否均固定注册；无搜索/抓取后端时返回可行动 `unavailable`。
- [x] `web_search` 校验 query、adapter 输出、结果总字节与 timeout，返回 canonical URL、sourceId 和 provenance。
- [x] `web_fetch` 接受 sourceId 或 URL，拒绝 userinfo；prepare 记录 host/IP，连接前复核地址，私网/回环/link-local/metadata 进入统一高风险事实。
- [x] SecureWebTransport 不自动跟随 redirect，并限制下载/解压字节、内容类型、TLS/DNS/timeout；3xx 返回 partial 和下一 sourceId。
- [x] 正文写入 Runtime artifact，通过 preview/contentRef 返回。

### Task 8：Skill、Task、Subagent、Tool Search、MCP 与数据库扩展迁移

**文件：**

- 修改：`packages/core-tools/src/skill-tools.ts`
- 修改：`packages/core-tools/src/agent-runtime-tools.ts`
- 修改：`packages/core-tools/src/subagent-tools.ts`
- 修改：`packages/core-agent/src/tool-search-index.ts`
- 修改：`packages/core-tools/src/mcp-tool-adapter.ts`
- 修改：`packages/core-tools/src/mcp-runtime-manager.ts`
- 修改：`packages/database-capability/src/database-capability-module.ts`
- 修改：`packages/agent-host/src/bundled-agent-runtime.ts`

- [x] Skill schema 只保留 search/load；资源正文进入 contentRef，`allowedTools` 只约束扩展 Tool。
- [x] Task 三工具改 deferred，修正 read/write metadata，补任务数量、字段和总大小上限。
- [x] Subagent 状态变更标 write，补 context/input 深度字节上限、wait timeout/cursor 和 expected errors；child 始终继承 baseline。
- [x] `tool_search` 实现互斥 query/select、稳定排序、limit/omitted metadata 和逐项状态；删除 `tool_describe`。
- [x] MCP 优先 annotations；缺失时用 external + unknown-risk + exclusive，所有返回作为 external payload，经统一结果主干；Terminal 在 Run 前执行 enabled/auto-start。
- [x] 默认 bundled Host 删除数据库特殊注册；数据库仅通过普通 Capability 注入并用外部 provider probe/resolve，不增加项目配置。

### Task 9：统一测试、故障注入、文档回写与架构复核

**文件：**

- 修改：`packages/core-agent/test/**`
- 修改：`packages/core-tools/test/**`
- 修改：`packages/agent-host/test/**`
- 修改：`apps/terminal/test/**`
- 修改：`packages/database-capability/test/**`
- 修改：`docs/architecture/base-tools-design.md`
- 修改：`docs/product/roadmap.md`
- 新增：`docs/engineering/base-tools-implementation.md`

- [x] 一次性迁移旧 Tool 名、旧 mode、旧 envelope 与旧测试 fixture；不保留 alias。
- [x] 覆盖 fixed manifest、prepared target TOCTOU、resource scheduler、owner ACL/cursor、权限三档、ask_user barrier、workspace stale digest、process orphan/spool/tree、Web DNS/redirect/private IP、MCP malformed/oversize 和 Capability probe。
- [x] 运行受影响包聚焦测试、`pnpm build:terminal`、`pnpm test:terminal`、`pnpm test:capability-runtime`，再按结果扩大到根 typecheck/lint/test。
- [x] 运行架构搜索：不存在 Capability 项目配置、Run mode 覆盖、`config_read`、旧 Tool 名、数据库基础 manifest、来源旁路或外部伪造 Runtime evidence。
- [x] 将实际实现、验证命令、通过数量、未运行的真实环境层和剩余风险写入中文工程文档，并把设计/路线图状态从“待实现”更新为有证据的实际状态。
