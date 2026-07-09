# BetaV0.1.1 Agent Shell Command 工具

## 用户价值

Agent 后续需要能帮助数据工程师运行项目命令、检查 git、执行脚本和定位环境问题。`run_shell_command` 提供了这个能力的后端基础，同时通过模式策略、白名单、黑名单、超时、输出上限和环境变量遮蔽降低风险。

## 本次内容

- 新增官方工具 `run_shell_command`。
- 新增官方插件 `official.shell-command`。
- 接入 desktop headless Agent 工具装配层。
- 实现真实 shell 子进程执行、timeout、abort、stdout/stderr 截断。
- 默认遮蔽敏感环境变量值。
- 对 readonly、ask、auto、full-auto 做差异化策略。

## 测试结果

- `tsc -p packages/core-tools/tsconfig.json --noEmit` 通过。
- `tsc -b apps/desktop/tsconfig.json --pretty false` 通过。
- `vitest run packages/core-tools/test/shell-tools.test.ts packages/core-tools/test/official-plugin-registry.test.ts packages/core-tools/test/official-plugin-tool-policy.test.ts apps/desktop/src/main/agent-tool-bootstrap.test.ts --passWithNoTests` 通过，33 个测试全部通过。
- touched files eslint 通过。

## 后续计划

- 将 shell 命令执行摘要接入 Agent audit log。
- 增加 process tree kill，避免复杂命令留下孙进程。
- 在最终前端中为审批弹窗展示完整命令、cwd、风险原因和输出上限。
