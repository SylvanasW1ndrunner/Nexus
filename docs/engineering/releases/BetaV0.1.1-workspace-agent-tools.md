# BetaV0.1.1 Workspace Agent 文件工具

## 背景

当前开发路线先完成无 UI 后端能力。工作区是数据工程师保存 SQL、Python 脚本、分析报告和 Agent 产物的基础容器。此前 `core-workspace` 已经有安全读写能力，但 Agent 工具层还不能直接使用这些能力。

## 本次变更

- `packages/core-tools` 新增 `registerWorkspaceTools()`。
- 新增内置工具：
  - `list_workspace_dir`
  - `read_workspace_file`
  - `write_workspace_file`
- 工具实现复用 `WorkspaceCore`：
  - workspace-relative 路径解析。
  - 拒绝绝对路径和 `..` 越界。
  - 写入走 `core-workspace` 的原子写入。
- `write_workspace_file` 标记为 medium / 非只读工具，遵守 Agent 权限矩阵。
- `read_workspace_file` 和 `list_workspace_dir` 标记为 safe / readonly 工具。

## 用户级场景

- Agent 完成分析后，可以把 Markdown 报告写入 `outputs/reports/`。
- Agent 可以读回工作区内的 SQL、报告或脚本文本作为上下文。
- Agent 可以列出工作区目录，定位用户已有制品。
- 用户未打开工作区时，工具返回明确错误，不触碰文件系统。
- 模型尝试通过 `../` 访问工作区外文件时，工具层拒绝。

## 测试

- `packages/core-tools/test/workspace-tools.test.ts`
  - 使用真实临时 workspace 创建目录结构。
  - 通过 Agent 工具写入、读取、列出报告文件。
  - 验证路径逃逸被拒绝。
  - 验证无活动 workspace 时不访问文件系统。

## 后续

- 增加 workspace file patch/edit 工具，用于更小粒度修改脚本和报告。
- 将 workspace Python script tool 接入 Agent 工具层。
- 为 workspace 工具增加执行审计记录。
