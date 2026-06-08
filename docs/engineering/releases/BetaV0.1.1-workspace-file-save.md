# BetaV0.1.1 项目文件保存能力

## 背景

BetaV0.1.1 的项目工作台需要同时管理 SQL 与 Python 脚本。此前界面可以从项目文件树打开 Python 文件，但保存能力主要围绕 SQL 入库，无法把已打开的 Python 脚本直接写回项目目录。

## 调整内容

- 新增 `workspace:write-file` IPC，用于保存当前项目内已打开的文件。
- `WorkspaceProjectStore.writeFile` 复用项目路径安全校验，禁止写入项目外路径和 `.dbagent` 内部配置。
- 前端“保存文件”会优先写回当前文件的 `relativePath`。
- Scratch SQL 或无项目相对路径的 SQL 仍走“保存 SQL”弹窗，保存到项目 SQL 库。
- 增加 Python 脚本保存测试，覆盖 `scripts/clean_orders.py` 写入和越界写入拦截。

## 产品影响

用户从左侧项目文件树打开 SQL、Python 或文档文件后，可以像 IDE 一样编辑并保存回项目。SQL 片段仍可通过保存弹窗沉淀为项目 SQL 库资产。

## 验收重点

- 打开项目内 Python 脚本后，编辑并点击保存文件，应写回原相对路径。
- 未打开项目时保存应提示先打开项目。
- 尝试写入项目外路径或 `.dbagent/workspace.json` 应被拒绝。
