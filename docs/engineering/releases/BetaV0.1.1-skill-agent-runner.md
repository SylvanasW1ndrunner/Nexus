# BetaV0.1.1 Skill Agent Runner

## 范围

本版本新增无 UI 后端 adapter：Skill execution plan 现在可以通过官方插件工具策略生成最终 Agent `allowedTools`，再调用 Agent runtime 执行。该能力服务于后续 Skill runner、slash command、auto-inject 和插件市场权限诊断。

## 变更

- 新增 `packages/core-tools/src/skill-agent-runner.ts`。
- 新增 `runSkillAgent()`：
  - 输入 Skill plan、工具策略参数和 Agent runner。
  - 输出 Agent run result、工具策略诊断和渲染后的用户任务。
- 新增 `renderSkillAgentUserMessage()`：
  - 稳定渲染 Skill 名称、说明、系统补充、步骤、输出格式和用户任务。
- `@dbagent/core-tools` 入口导出 Skill Agent runner。

## 安全说明

- Skill `allowedTools` 不是放权入口，只能在官方插件策略允许范围内进一步收窄。
- runner 不绕过 `ReactAgent` 的 allowedTools、permission manager、approval provider、approval provenance 和 tool handler 校验。
- runner 不捕获或伪装 Agent 失败；provider timeout、tool failure、quota 等错误继续由 Agent runtime 表达。
- 本切片没有新增外部依赖，无打包体积影响。

## 验证记录

- `pnpm exec tsc -p packages/core-tools/tsconfig.json --noEmit`
- `pnpm exec eslint packages/core-tools/src/skill-agent-runner.ts packages/core-tools/test/skill-agent-runner.test.ts`
- `pnpm exec vitest run packages/core-tools/test/skill-agent-runner.test.ts packages/core-tools/test/official-plugin-tool-policy.test.ts packages/core-tools/test/official-plugin-registry.test.ts`
  - 3 个测试文件通过。
  - 15 个用例通过。

## 已知边界

- 桌面主进程还没有接入该 runner。
- 当前 runner 不负责 Skill auto-inject、slash command 解析或 UI 诊断展示。
- 当前 runner 不实现新的 Agent strategy；仍复用已有 `ReactAgent`。
