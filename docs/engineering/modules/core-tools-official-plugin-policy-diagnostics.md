# core-tools 官方插件工具策略诊断

## 范围

本模块补齐官方插件工具策略的可观测性。它不注册 tool handler，不启动插件，不访问网络，也不改变 Agent 实际执行权限；它只把“工具为什么可用或不可用”输出为结构化后端合同，供桌面主进程、后续设置页、插件市场、Skill 调试和发布前验收使用。

代码入口：
- `packages/core-tools/src/official-plugin-registry.ts`：官方插件 manifest、runtime tool 匹配、被拦截工具诊断、缺失静态工具诊断。
- `packages/core-tools/src/official-plugin-tool-policy.ts`：把官方插件策略、真实 `ToolRegistry`、Skill `allowedTools` 合并成 Agent 可执行工具白名单。
- `packages/shared/src/ipc.ts`：桌面端可序列化的 `AgentToolPolicyPreview`。
- `apps/desktop/src/main/agent-service.ts`：无 UI 的 headless Agent 服务策略预览映射。

## 诊断输出

`OfficialPluginRegistry.resolveRuntimeTools()` 保留原有字段：
- `allowedToolNames`
- `blockedToolNames`
- `staticToolNames`
- `dynamicToolNames`
- `missingStaticToolNames`

新增结构化字段：
- `blockedToolDetails`：说明 runtime tool 被官方插件策略拦截的原因。
- `missingStaticToolDetails`：说明当前策略允许、但真实 runtime 未注册的官方静态工具。

支持的拦截原因：
- `plugin-disabled`：工具由已禁用的官方插件贡献。
- `static-tool-source-mismatch`：动态来源使用了受保护的官方静态工具名，例如 MCP tool 冒用 `query_database`。
- `readonly-required`：当前策略要求只读工具，但贡献或 runtime tool 不是只读。
- `danger-level-exceeds-limit`：贡献或 runtime tool 超过当前最大风险等级。
- `permission-not-allowed`：贡献需要的权限不在 allow list 中。
- `no-plugin-contribution`：真实 runtime tool 没有任何官方插件贡献声明。

`resolveOfficialPluginAgentTools()` 额外区分两类上层拦截：
- `blockedByPluginToolDetails`：Skill 想用，但插件策略、runtime 缺失或过滤条件不允许。
- `blockedBySkillToolDetails`：插件策略允许，但当前 Skill 没声明，因此不能进入本次 Agent run。

## 安全边界

诊断字段是解释信息，不是授权信息。最终能进入模型和执行器的仍然只有 `agentAllowedToolNames`，执行前仍由 `core-agent` permission manager、approval provider 和具体 tool handler 兜底。

诊断中只暴露插件 id、插件名、贡献名、权限 id、风险等级、只读标记、runtime source/sourceId/originalName，不暴露密钥、连接串、SQL 参数、文件内容或模型上下文。

## 测试覆盖

- `packages/core-tools/test/official-plugin-registry.test.ts`
  - 静态官方工具名被动态来源冒用时输出 `static-tool-source-mismatch`。
  - disabled plugin、readonly、danger level、permission allow list、unknown runtime tool 都有明确原因。
  - `missingStaticToolDetails` 能说明缺失工具所属插件和权限。
- `packages/core-tools/test/official-plugin-tool-policy.test.ts`
  - Skill 与官方插件策略取交集。
  - 缺失 runtime tool 输出 `runtime-tool-missing`。
  - Skill 未声明但插件允许的工具输出 `skill-tool-not-allowed`。
- `apps/desktop/src/main/agent-service.test.ts`
  - `previewToolPolicy()` 不调用模型。
  - desktop DTO 能返回结构化 blocked/missing 诊断。

## 后续扩展

插件市场 UI、项目设置和 Agent 调试面板后续可以直接消费这些字段，不需要重新推导权限原因。第三方插件接入后，应沿用同一套 reason 枚举，并在 adapter 层把市场插件、MCP server 和 workspace script 的贡献转换为统一诊断结构。
