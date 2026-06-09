# BetaV0.1.1 工作区新建文件能力

## 背景

IDE 左侧资源管理器需要具备项目内文件创建能力，否则用户只能通过外部文件管理器准备 SQL、Python 和文档文件，工作流不完整。

## 实现内容

- 在左侧项目文件树标题栏增加“新建文件”入口。
- 新增新建文件弹窗，用户输入项目内相对路径，例如 `scripts/clean_orders.py`、`sql/analytics/orders.sql`、`docs/runbook.md`。
- 创建文件时复用主进程已有的 `workspace.writeFile` IPC，不绕过工作区路径安全校验。
- 创建成功后刷新文件树，并自动在编辑器中打开新文件。
- 统一文件语言识别逻辑：
  - `.sql` 使用 SQL 编辑器。
  - `.py` 使用 Python 编辑器。
  - `.md` / `.markdown` 使用 Markdown 编辑器。
  - 其他类型保持纯文本。

## 安全边界

渲染端先做用户输入校验，拒绝空路径、目录路径、绝对路径、路径逃逸、`.dbagent`、`node_modules` 等不应由用户直接写入的位置。主进程仍保留最终防线：`WorkspaceProjectStore.writeFile` 会再次规范化路径并限制写入只能发生在项目根目录内部。

## 测试覆盖

- 路径输入归一化：Windows 分隔符、前导斜杠、空白字符。
- 非法路径拦截：空路径、`..` 逃逸、目录路径、`.dbagent`、`node_modules`、Windows 绝对路径。
- 编辑器语言识别：SQL、Python、Markdown、纯文本。
- 新文件默认模板：SQL、Python、Markdown 和空白文本。

## 后续优化

- 增加右键菜单：新建文件、新建文件夹、重命名、删除。
- 支持在选中的目录下创建文件，减少用户手动输入目录前缀。
- 对已存在文件增加覆盖确认或改为打开已有文件。
