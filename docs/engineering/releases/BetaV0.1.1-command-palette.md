# BetaV0.1.1 命令面板增量

## 目标

本轮把插件贡献点接入 IDE 命令系统，新增类似 VS Code / JetBrains 的命令面板。命令面板把核心 IDE 命令和已启用插件贡献命令合并为一个可搜索入口，避免功能只能散落在菜单、按钮或设置页中。

## 入口

- 原生菜单：`视图 -> 命令面板...`
- 快捷键：`CmdOrCtrl+Shift+P`
- 前端也监听同一快捷键，保证窗口焦点在 renderer 时仍可打开。

## 命令来源

命令面板包含两类命令：

- 核心命令：新建项目、打开项目、保存文件、运行 SQL、分析 SQL、打开设置、切换侧栏。
- 插件命令：来自已安装且已启用插件的 `contributes.commands`。

插件命令会根据上下文启用或禁用。例如：

- PostgreSQL Explain 需要当前编辑器是 SQL 且已有活动连接。
- Python 创建 venv 需要已打开项目。
- 结果导出和图表预览需要已有查询结果。

## 当前绑定

官方插件命令当前绑定到已有 IDE 能力：

- `dbagent.postgres.explain` -> 分析当前 SQL。
- `dbagent.python.detect` -> 检测 Python 环境。
- `dbagent.result.exportCsv` -> 导出 CSV。
- `dbagent.result.exportJson` -> 导出 JSON。

未具备运行时视图的插件命令会返回明确占位消息，不静默失败。

## 后续

完整命令系统还需要：

- 独立 command registry 模块，而不是全部集中在 `App.tsx`。
- 菜单、快捷键、命令面板和插件 handler 的统一注册机制。
- 第三方插件运行时加载后，将 command id 绑定到隔离执行环境。
- 命令 palette 支持键盘上下选择、最近使用排序和命令分组。
