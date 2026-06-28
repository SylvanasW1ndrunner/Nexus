# 2026-06-28 切片：Agent 激活工作区工具接线

## 背景

当前阶段采用“功能优先，前端最后统一重建”的开发路径。桌面端已经可以把数据库工具、Schema RAG 工具和工作区文件工具注册到 Agent `ToolRegistry`，但工作区工具此前没有接入当前激活项目，执行时固定返回 `No active workspace.`。

这个切片补齐桌面端 Agent 对当前 Workspace 的后端访问能力，使 Agent 在已有项目打开后可以通过受控工具列目录、读取文件和原子写入文件。该能力后续会作为官方内置插件 `official.workspace-files` 的运行时贡献之一使用。

## 实现范围

- `packages/core-tools/src/workspace-tools.ts`
  - `getWorkspaceRoot` 从同步 provider 扩展为同步或异步 provider。
  - 每次工具执行时 `await getWorkspaceRoot()`，不缓存工作区路径。
  - 保持 `WorkspaceCore` 的路径越界保护、UTF-8 读取和原子写入边界不变。
- `apps/desktop/src/main/agent-tool-bootstrap.ts`
  - 桌面端注册工作区工具时，通过 `WorkspaceProjectStore.loadActive()` 读取当前激活项目。
  - 只把 `rootPath` 传给 core 工具，不把 Electron store、IPC 或 renderer 状态泄漏进 core 包。
- 测试
  - core-tools 覆盖异步 active workspace root provider。
  - desktop bootstrap 覆盖“注册时无项目、执行前打开项目”的真实工作区文件读写场景。

## 接口边界

- core-tools 仍然不依赖 Electron。
- desktop main 只负责组合依赖，不实现文件读写细节。
- workspace 工具访问必须经过 `WorkspaceCore`，不能绕过 workspace root 路径校验。
- 工具执行时读取最新 active project，支持用户后续切换或关闭项目后的状态变化。

## 验收标准

- 没有激活项目时，workspace 工具必须明确失败并返回 `No active workspace.`。
- 激活项目后，Agent 可以写入 `outputs/summary.md`、读取该文件，并且文件实际存在于 workspace 根目录下。
- 异步 workspace root provider 可以被 core-tools 正确等待。
- 该切片不引入新的第三方依赖，不触碰正式 renderer UI。

## 后续

- 把 workspace script tools 注册到 desktop Agent runtime，并继续走 official plugin tool policy。
- 在 Agent session 中记录 workspace 工具调用审计摘要。
- 增加项目切换后的 workspace tool regression：旧项目关闭后不得继续访问旧 root。
