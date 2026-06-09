# BetaV0.1.1 IDE 设置持久化增量

## 目标

本轮把 IDE 设置从前端占位控件升级为可持久化配置。设置不再只停留在弹窗 UI，而是通过主进程写入用户数据目录，并在启动时恢复，保证打包后的桌面程序可以保留用户偏好。

## 接口

新增 IPC：

- `app:load-ide-settings`：读取 IDE 设置；文件不存在或 JSON 损坏时返回默认设置。
- `app:save-ide-settings`：保存设置 patch，主进程做范围归一化后原子写入。

设置模型：

- `appearance`：语言、主题、界面密度。
- `editor`：字体、字号、tab size、自动换行、minimap、行号。
- `terminal`：默认 shell、字体、字号、scrollback、光标闪烁。

## 主进程

- `apps/desktop/src/main/ide-settings-store.ts` 负责默认值、归一化、读取和原子写入。
- 配置文件路径为 Electron `userData/data/ide-settings.json`。
- 保存终端默认 shell 后，`TerminalService.configure` 会更新后续新建终端使用的 shell。

## 前端

- 启动时先加载 IDE 设置，再创建首个终端，避免默认 shell 配置被首个终端错过。
- IDE 设置弹窗中的外观、编辑器、终端设置都改为可编辑控件。
- 保存后立即应用到 Monaco 编辑器和底部终端显示。

## 测试

- `apps/desktop/src/main/ide-settings-store.test.ts` 覆盖默认值、保存读取、损坏 JSON 恢复和范围归一化。
- `packages/shared/test/ipc-contract.test.ts` 覆盖新增 IPC 通道。

## 当前边界

- `light` 主题已进入配置模型，但前端色板尚未完整实现；当前视觉仍以深色工作台为主。
- 默认 shell 当前按可执行文件路径处理，不解析带参数的 shell 命令。后续接入完整终端配置时应支持 shell path 与 args 分离。
