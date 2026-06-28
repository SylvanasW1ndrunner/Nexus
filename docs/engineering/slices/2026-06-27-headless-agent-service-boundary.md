# 2026-06-27 Headless Agent Service 边界切片

## 目标

在前端 UI 冻结的前提下，先把 Agent/Skill 的主进程服务边界和 typed IPC 合同落地。该切片让后续 UI、命令面板或测试入口可以通过稳定接口完成：

- 工具策略预检。
- Skill 自动匹配诊断。
- 自动 Skill Agent 运行。
- 运行中止。

本切片不开发 renderer UI，不接真实内置 Skill 文件，不接真实 PostgreSQL/RAG/Python 工具装配，不调用真实 LLM。

## 实现范围

- `packages/shared/src/ipc.ts`
  - 新增 `skills:match`。
  - 新增 `agent:tool-policy-preview`。
  - 新增 `agent:run`。
  - 新增 `agent:abort`。
  - 新增 Agent/Skill IPC request/response 类型。
- `apps/desktop/src/main/agent-service.ts`
  - 新增 `HeadlessAgentService`。
  - 注入 `SkillAgent`、`ToolRegistry` 和 Skill loader。
  - 组合官方插件策略、Skill matcher、Auto Skill Agent Runner 和 abort controller。
- `apps/desktop/src/main/main.ts`
  - 注册 Agent/Skill IPC handler。
  - 初始化空 `ToolRegistry` 和空 `SkillRegistry`，保证当前最小宿主不会白屏或因为未装配工具崩溃。
- `apps/desktop/src/main/agent-service.test.ts`
  - 用 fake provider、真实 `ReactAgent` 和真实 `ToolRegistry` 做服务级测试。

## 设计逻辑

本切片把依赖方向固定为：

`shared typed contract` → `desktop main service` → `core-tools/core-skills/core-agent`

`core-agent` 不反向依赖 `core-tools` 或 `core-skills`。Agent runtime 仍只知道 LLM、工具注册表、权限和用量；Skill 自动匹配与官方插件策略由 service 组合。

`agent:run` 的执行过程：

1. 根据当前 runtime tools 和请求 mode 计算官方插件工具策略。
2. 在策略允许的工具集合内自动匹配 Skill。
3. 如果没有可执行 Skill，返回 `no_matching_skill` 和候选缺失工具诊断，不调用 LLM。
4. 如果匹配成功，复用 `runAutoSkillAgent()` 调用 `ReactAgent`。
5. `ReactAgent` 仍做运行时 `allowedTools` 硬白名单校验；即使模型返回隐藏工具调用，也不会执行。

## 安全边界

- Shared IPC 类型只包含可序列化字段，不泄露主进程对象、handler、凭证或 provider 实例。
- `Skill allowedTools` 只能收窄官方插件策略，不能扩大权限。
- `readonly` mode 会在工具策略预检阶段移除非 readonly 工具，并在 `ReactAgent` 权限层再次兜底。
- `agent:abort` 只通过 runId 触发 AbortController，不暴露底层进程或 provider 对象。
- 当前 main 未注册真实工具，因此不会因为 IPC 暴露而执行数据库、文件或 Python 副作用。

## 开源与依赖评估

本切片不引入外部依赖，只增加 workspace 包依赖：

- `@dbagent/core-agent`
- `@dbagent/core-skills`
- `@dbagent/core-tools`

原因：

- 该能力是已有内部模块的服务边界组合，不需要引入 Agent workflow 框架。
- 使用现有 `ReactAgent` 和 `runAutoSkillAgent()` 可以验证产品自己的权限链路，而不是把核心安全边界交给第三方框架。
- 后续如接入 OpenAI/Vercel AI SDK、LangGraph、Mastra、LlamaIndex 等，应在 LLM/tool adapter 层隔离，不改变 shared IPC 合同。

## 测试

- IPC 合同快照新增 Agent/Skill channel。
- `skills:match` 不调用模型，只返回候选和工具策略。
- `agent:run` 能命中日报 Skill，并只向模型暴露 Skill 与官方插件策略的交集工具。
- Python Skill 缺少 `workspace_script:run_python_analysis` 时返回 `no_matching_skill`，不调用模型。
- fake provider 返回隐藏 `execute_sql` 时，真实 `ReactAgent` 拒绝执行，handler 未触发。
- `agent:abort` 能取消运行中的 fake provider 请求，并返回 `aborted`。

## 后续

- 加载内置 Skill 文件和用户/工作区 Skill 目录。
- 把 DB/RAG/workspace/Python 工具装配到 main 的 `ToolRegistry`。
- 增加真实 PostgreSQL、真实 SiliconFlow、真实 Python 子进程的门控验收。
- 对 `agent:run` 增加 stream/checkpoint/recovery IPC。
