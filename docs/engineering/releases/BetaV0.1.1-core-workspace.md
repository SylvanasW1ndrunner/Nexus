# BetaV0.1.1 Core Workspace

## 背景

当前目标是先完成功能模块，最后统一开发前端 UI。工作区能力是 Agent 写脚本、保存 SQL、沉淀报告和复用 Skill 的基础，因此需要从 Electron main 的实现中抽出一个无 UI、无 Electron 依赖的 core 包。

## 本次实现

新增 `packages/core-workspace`：

- `WorkspaceCore`
  - 创建工作区。
  - 打开工作区。
  - 原子写入文件。
  - 读取文件。
  - 列出工作区文件。
  - 保存带元数据的 SQL。
  - 发现 Python 脚本工具。
- `WorkspaceAutosaveStore`
  - 为 SQL、Python、Markdown 和普通文本草稿提供无 UI 的自动保存合同。
  - 支持 debounce 写入，短时间连续编辑时只保存最新内容。
  - 支持 `flush()` / `flushAll()`，用于应用退出、切换工作区或崩溃前保护用户输入。
  - 支持启动恢复扫描，按最新保存时间列出可恢复草稿。
  - 支持按草稿类型和工作区路径过滤，便于未来 UI 只展示当前工作区相关草稿。
  - 草稿文件使用 hash 文件名和原子 JSON 写入，避免 tab id 或路径片段污染文件系统。
  - 损坏草稿文件会被忽略，不阻塞应用启动和其他草稿恢复。
- 路径工具
  - 受管理目录校验。
  - 相对路径规范化。
  - 工作区根目录内解析。
- 脚本工具解析
  - 支持 `DBAgent Tool: name`。
  - 支持 `@tool name`。
  - 支持 `@param name: type 描述`。

## 用户级测试场景

已覆盖：

- 用户新建“电商分析项目”后，自动生成 SQL、scripts、docs、outputs、skills 等目录。
- 用户配置 venv Python 环境后，workspace.json 正确保存配置。
- 用户保存“每日 GMV”SQL 后，文件写入 SQL 库并带 `@name`、`@connection`、`@tags` 元数据。
- 用户写 Python 脚本时，文件只能写入受管理目录。
- 用户不能通过 `..` 或 `.dbagent/workspace.json` 修改工作区内部配置。
- Agent 能扫描 `scripts/decrypt_phone.py` 并识别为 `workspace_script:decrypt_phone`。
- 文件列表不会暴露 `.dbagent` 内部。
- 普通文件夹没有有效 workspace.json 时不能误打开。
- 用户编辑 SQL 时连续输入多次，autosave 只恢复最后一次编辑内容。
- 用户同时打开 SQL 和 Python 草稿，退出前 `flushAll()` 会把两个草稿全部落盘。
- 应用重启后恢复列表按最新保存时间展示，并能按类型或工作区过滤。
- 某个 autosave JSON 损坏时，恢复扫描跳过坏文件，其他草稿仍可恢复。
- 用户接受或丢弃恢复草稿后，可删除对应 autosave 文件。

## 当前边界

已实现：

- 工作区创建和打开。
- 原子文件写入。
- SQL 元数据文件保存。
- Python 脚本工具声明扫描。
- 路径安全。
- SQL/Python/Markdown/Text 草稿自动保存。
- 启动恢复扫描和损坏草稿降级。

暂未实现：

- Python 子进程执行。
- requirements 安装。
- workspace Skill YAML 完整 parser。
- workspace 级 MCP 合并。
- history.jsonl 审计。
- 最近工作区状态。

下一步应将 `core-workspace` 与 `core-tools` 连接，形成 `read_workspace_file`、`write_workspace_file`、`list_workspace_dir`、`workspace_script:*` 等 Agent 工具。
