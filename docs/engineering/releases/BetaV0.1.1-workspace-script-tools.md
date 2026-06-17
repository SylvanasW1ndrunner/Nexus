# BetaV0.1.1 Workspace Python Script Tools

## 背景

产品文档要求工作区内的 Python 脚本可以沉淀为 Agent 可调用工具。此前 `core-workspace` 已能解析脚本 docstring 元数据，但工具层还不能把这些脚本注册给 Agent，也不能对参数和权限做统一约束。

## 本次变更

- `packages/core-tools` 新增 `registerWorkspaceScriptTools()`。
- 扫描 `WorkspaceCore.discoverScriptTools()` 返回的脚本工具声明。
- 将脚本注册为 `workspace_script:*` Agent 工具。
- 根据 docstring 中的 `@param` 生成基础 JSON schema。
- 执行前按声明类型校验参数：
  - `str` / `string`
  - `int` / `integer`
  - `float` / `number`
  - `bool` / `boolean`
- 脚本工具统一标记为 `medium`、非只读，交给 `PermissionManager` 控制执行边界。
- 执行器通过 `WorkspaceScriptRunner` 注入，避免 `core-tools` 反向依赖 Electron main 或某个固定 Python runtime。

## 用户级场景

- 用户在 `scripts/summarize_orders.py` 中写 docstring：
  - `DBAgent Tool: summarize_orders`
  - `@param count: int 订单数量`
  - `@param region: str 区域`
- 打开工作区后，后端可注册 `workspace_script:summarize_orders`。
- Agent 调用该工具时，参数先被校验，再交给真实 Python runner 执行。
- 如果模型传错参数类型，例如把 `count` 传为字符串，runner 不会启动，用户得到明确错误。

## 测试

- `packages/core-tools/test/workspace-script-tools.test.ts`
  - 创建真实临时 workspace。
  - 写入带 `DBAgent Tool:` docstring 的 Python 脚本。
  - 使用真实 Python 进程 runner 执行脚本。
  - 验证工具权限等级和参数 schema。
  - 验证参数类型错误不会启动 runner。
  - 验证无活动 workspace 时不能发现脚本工具。

## 边界

- 当前不在 `core-tools` 内固定 Python 解释器选择策略；解释器解析仍由主进程 Python runtime 或测试 runner 负责。
- 当前只实现整脚本执行，不支持长任务流式日志、取消、资源限制细节和 checkpoint，这些属于后续 Python runtime / Agent checkpoint 切片。
