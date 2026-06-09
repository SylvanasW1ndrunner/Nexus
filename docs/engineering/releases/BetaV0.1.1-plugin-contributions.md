# BetaV0.1.1 插件贡献点增量

## 目标

本轮把插件市场从“官方插件列表”推进为“插件 manifest + 状态 + 贡献点”的基础机制。现阶段仍不加载第三方代码，但官方插件已经使用与后续第三方插件一致的数据结构，便于后续扩展市场、签名校验、权限模型和安装目录。

## Manifest

`PluginManifest` 新增：

- `builtin`：内置插件标记。内置插件不能卸载，但可以禁用。
- `activationEvents`：声明激活时机，例如 `onLanguage:python`、`onResultSet`。
- `contributes.commands`：插件贡献的命令。
- `contributes.views`：插件贡献的视图入口。
- `contributes.configuration`：插件贡献的配置项。

## 状态

插件状态仍写入 Electron `userData/data/plugins.json`，记录：

- `installed`
- `enabled`

状态文件损坏时，主进程会回退为空状态，保证插件市场和 IDE 启动不被单个 JSON 文件拖垮。

## 操作

新增 IPC：

- `plugin:enable`
- `plugin:disable`

保留：

- `plugin:list`
- `plugin:install`
- `plugin:uninstall`

内置官方插件不能卸载；可选官方插件可以安装、卸载、启用和禁用。

## 前端

插件市场现在展示：

- 插件发布者、版本、官方/内置标记。
- 分类和激活事件。
- 命令与视图贡献点。
- 安装/卸载、启用/禁用按钮。

## 测试

- `apps/desktop/src/main/plugin-registry.test.ts` 覆盖官方插件贡献点、安装持久化、启用/禁用、内置插件不可卸载、损坏状态文件恢复。
- `packages/shared/test/ipc-contract.test.ts` 覆盖新增插件 IPC。

## 后续

完整插件系统还需要：

- 插件包格式和安装目录。
- 插件签名校验。
- 权限声明和运行隔离。
- 第三方插件加载沙箱。
- 命令 palette、菜单和视图挂载运行时。
