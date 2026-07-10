# core-tools：Agent 工作区文件工具

## 模块职责

`@dbagent/core-tools` 负责把后端能力注册为 Agent 可调用工具。工作区文件工具属于官方内置能力 `official.workspace-files` 的运行时来源，但本模块不持有 Electron 状态，也不读取桌面端配置。

桌面端只提供 `getWorkspaceRoot()`，每次工具执行时动态读取当前 active workspace，避免工具注册时缓存旧路径。

## 当前工具

- `list_workspace_dir`：列出 active workspace 内目录。
- `read_workspace_file`：读取 active workspace 内 UTF-8 文本文件。
- `write_workspace_file`：在 active workspace 内原子写入 UTF-8 文本文件。
- `edit_workspace_file`：用精确 `oldText -> newText` 替换编辑文件；多处命中时必须显式传入 `replaceAll=true`。
- `delete_workspace_file`：删除文件时移入 `outputs/_trash/deleted/...`，不做永久删除；目录不能通过该工具删除。
- `glob_workspace`：按 `sql/**/*.sql`、`scripts/**/*.py` 这类 glob 模式查找工作区文件和目录。
- `grep_workspace`：在 UTF-8 文本文件内搜索内容，返回路径、行号、列号和预览。

## 安全边界

- 没有 active workspace 时统一抛出 `No active workspace.`。
- 所有写入、读取、删除路径必须通过 `core-workspace` 的托管目录边界，只允许 `queries`、`sql`、`scripts`、`skills`、`docs`、`outputs`、`notebooks`。
- `delete_workspace_file` 只移动文件到 workspace 内的回收目录，保留恢复可能性。
- `glob_workspace` 和 `grep_workspace` 默认跳过 `.git`、`.dbagent`、`node_modules` 和 `_trash`，避免扫描内部状态、依赖和回收内容。
- `grep_workspace` 有单文件大小上限，默认 `512 KiB`；`glob_workspace` / `grep_workspace` 都有 `limit`，达到限制后停止递归扫描。
- 工具名称、风险等级和 readonly 元数据必须与 `official.workspace-files` 官方插件清单一致。

## 实现取舍

当前没有引入 `fast-glob` 或 `ripgrep` 依赖。原因是本阶段优先保证 Electron 打包可控、跨平台行为一致，并且 workspace 工具还处在后端能力成型期。

后续如果真实大工作区搜索性能不足，可以把 `glob_workspace` / `grep_workspace` 的实现替换为 adapter：

- `fast-glob`：纯 Node glob，适合文件发现。
- `ripgrep`：性能更强，但需要处理二进制分发、Windows/Linux/macOS 打包和 release 体积。

替换时对外工具契约不变，只替换内部搜索 adapter。

## 测试入口

- `packages/core-tools/test/workspace-tools.test.ts`
  - 真实临时 workspace 写入、读取、列目录。
  - 路径逃逸拦截。
  - 精确编辑、多匹配拒绝、`replaceAll`。
  - 删除移入回收目录。
  - glob 查找 SQL/Python 文件。
  - grep 内容搜索、大小写不敏感搜索、回收目录跳过。
- `packages/core-tools/test/official-plugin-registry.test.ts`
  - 校验 `official.workspace-files` 静态工具贡献。
- `apps/desktop/src/main/agent-tool-bootstrap.test.ts`
  - 校验桌面端 headless Agent 注册到完整 workspace 工具集。
