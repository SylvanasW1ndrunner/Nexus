# 2026-07-10：Agent 工作区高级文件工具

## 背景

产品文档要求 Agent 内置工具覆盖工作区读写、精确编辑、删除、glob 和 grep。此前后端只提供 `list_workspace_dir`、`read_workspace_file`、`write_workspace_file`，无法支撑 Agent 对脚本、SQL 和报告进行完整的文件级操作。

## 本轮实现

- 在 `packages/core-tools/src/workspace-tools.ts` 新增：
  - `edit_workspace_file`
  - `delete_workspace_file`
  - `glob_workspace`
  - `grep_workspace`
- `delete_workspace_file` 采用移动到 `outputs/_trash/deleted/...` 的方式，不做永久删除。
- `glob_workspace` / `grep_workspace` 默认跳过内部目录和回收目录，并在达到 `limit` 后停止递归。
- `official.workspace-files` 官方插件清单增加搜索、编辑、删除能力。
- 桌面端 headless Agent bootstrap 测试同步校验新增工具。

## 验证

- `tsc -p packages/core-tools/tsconfig.json --noEmit --pretty false`
- `vitest run packages/core-tools/test/workspace-tools.test.ts packages/core-tools/test/official-plugin-registry.test.ts apps/desktop/src/main/agent-tool-bootstrap.test.ts --passWithNoTests`
- `eslint packages/core-tools/src/workspace-tools.ts packages/core-tools/src/official-plugin-registry.ts packages/core-tools/test/workspace-tools.test.ts packages/core-tools/test/official-plugin-registry.test.ts apps/desktop/src/main/agent-tool-bootstrap.test.ts`
- `tsc -b apps/desktop/tsconfig.json --pretty false`
- `git diff --check`
- `node scripts/smoke.mjs`

## 后续

- 如果大工作区搜索性能不足，将 `glob_workspace` 和 `grep_workspace` 的内部实现替换为 `fast-glob` / `ripgrep` adapter。
- UI 阶段再接入 diff 预览、删除恢复入口和搜索结果面板。
