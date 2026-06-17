# BetaV0.1.1 Core Tools 内置工具

## 背景

已有 `core-agent`、`core-db` 和 `core-rag` 后，仍需要一个稳定的工具层把这些能力连接起来。否则 Agent 只能有运行时，不能真正代表用户执行数据库 IDE 工作流。

## 本次实现

新增 `packages/core-tools`：

- `registerDatabaseTools()`
  - `list_schemas`
  - `list_tables`
  - `describe_table`
  - `query_database`
  - `execute_sql`
  - `search_schema`
  - `build_schema_context`
- 参数校验工具
  - 必填字符串
  - 可选字符串
  - 可选正整数
- workspace 沙箱路径解析
  - 只接受相对路径
  - 拒绝绝对路径
  - 拒绝 `..` 越界
- `registerWorkspaceTools()`
  - `list_workspace_dir`
  - `read_workspace_file`
  - `write_workspace_file`
  - 复用 `core-workspace` 的读写和原子写入边界
- `registerWorkspaceScriptTools()`
  - 发现 `scripts/` 下带 `DBAgent Tool:` 或 `@tool` docstring 的 Python 脚本
  - 注册为 `workspace_script:*` Agent 工具
  - 执行器由调用方注入，core-tools 不直接依赖 Electron main

## 权限策略调整

修正 `core-agent` 权限矩阵：

- readonly Agent 模式允许 `readonly: true` 的工具，即使工具危险等级是 medium。
- readonly Agent 模式继续拒绝所有非只读工具。

原因：

- `query_database` 是 SELECT 类分析工具，属于只读能力。
- 用户选择 readonly 模式时，预期是“不能写库”，不是“不能查询数据”。

## 用户级测试场景

已覆盖：

- Agent 先调用 `search_schema` 查“订单金额”，再调用 `query_database` 查订单总数，最后返回业务答案。
- 用户探索数据库时，`list_schemas`、`list_tables`、`describe_table` 返回稳定结构。
- 用户在 readonly 模式要求删除数据时，`execute_sql` 在 driver 执行前被拒绝。
- 当前连接不存在时，查询工具返回明确错误。
- workspace 工具路径不能访问绝对路径，也不能通过 `..` 逃逸工作区。
- Agent 能在真实 workspace 中写入分析报告、读回内容，并列出输出目录。
- 未打开 workspace 时，workspace 工具返回明确错误，不触碰文件系统。
- Agent 能发现并执行工作区 Python 脚本工具。
- Python 脚本工具参数类型错误时，不启动执行器。

## 当前边界

已实现：

- DB/RAG 内置工具注册。
- Workspace 文件内置工具注册。
- Workspace Python script tool 注册。
- Agent 权限联动。
- 工具参数校验。
- workspace 路径沙箱 helper。

暂未实现：

- Shell tool。
- Workspace file edit/patch tool。
- MCP tool adapter。
- Tool execution audit store。

这些能力应继续通过 core 抽象接入，避免 renderer 或 Electron main 服务直接污染 Agent 核心包。
