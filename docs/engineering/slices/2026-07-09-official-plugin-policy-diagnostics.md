# 2026-07-09 官方插件工具策略诊断

## 范围

本切片增强后端官方插件策略的诊断能力，目标是让 Agent、Skill、MCP 和后续插件市场都能解释工具白名单的来源和拦截原因。

本次不涉及 renderer UI，不改变 Agent 执行行为，不新增第三方依赖。

## 变更

- `resolveRuntimeTools()` 新增 `blockedToolDetails` 和 `missingStaticToolDetails`。
- `resolveOfficialPluginAgentTools()` 新增 `blockedByPluginToolDetails` 和 `blockedBySkillToolDetails`。
- shared IPC `AgentToolPolicyPreview` 暴露同样的诊断 DTO。
- desktop `HeadlessAgentService.previewToolPolicy()` 返回结构化诊断。
- 补充 core-tools 和 desktop 服务测试，覆盖真实 `ToolRegistry`、Skill allowedTools、官方插件开关、只读策略、风险等级、权限 allow list 和未知 runtime tool。

## 验收

- `tsc -p packages/core-tools/tsconfig.json --noEmit`
- `tsc -p packages/shared/tsconfig.json --noEmit`
- `tsc -b apps/desktop/tsconfig.json --pretty false`
- `vitest run packages/core-tools/test/official-plugin-registry.test.ts packages/core-tools/test/official-plugin-tool-policy.test.ts --passWithNoTests`
- `vitest run apps/desktop/src/main/agent-service.test.ts --passWithNoTests`
- 指定文件 ESLint 通过。

## 风险

- 这是兼容扩展，原有名称数组字段保留。
- 新字段会增加 preview payload 体积，但内容只包含权限元数据和 tool source 元数据，不包含密钥或用户数据。
- `missingStaticToolDetails` 只描述当前策略允许但 runtime 未注册的静态工具；被 readonly/danger/permission 过滤掉的贡献不会出现在 missing 列表中。
