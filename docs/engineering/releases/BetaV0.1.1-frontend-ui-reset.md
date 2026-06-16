# BetaV0.1.1 前端 UI 重置记录

## 本次变更

- 删除旧 `App.tsx` 大型 IDE 界面实现，改为最小启动宿主。
- 清空旧样式体系，只保留前端重构占位页所需样式。
- 保留 Electron 主进程、preload、IPC、数据库、认证、Python、终端、插件和工作区核心能力。
- 保留 renderer 下的纯函数工具模块，供后续新 UI 按规格复用。
- 新增 `docs/design/frontend-ui-rebuild-spec.md`，将后续前端开发模式调整为先设计规格、再低保真实现、再功能接线。

## 临时启动页

启动页显示 DBAgent Desktop、前端 UI 正在重构，以及基础 IPC 健康检查结果：

- 认证 IPC：调用 `auth:status`。
- 设置 IPC：调用 `app:load-ide-settings`。
- 认证模式：显示本地测试或 PostgreSQL 认证模式。
- 界面语言：显示当前 IDE 设置语言。

该页面不是最终产品界面，只用于保证重构期间 Electron 不白屏，并证明 renderer 到 preload/main 的链路仍然可用。

## 删除边界

本次删除的是 UI 层，不删除以下能力：

- `apps/desktop/src/main/**`
- `apps/desktop/src/preload/**`
- `packages/**`
- renderer 下可复用的纯函数模块和测试

后续如果某些纯函数被证明与旧 UI 强绑定，再在对应模块重建时清理。

## 后续要求

- 新 UI 模块必须先补中文设计说明和验收清单。
- 不再以旧界面为基础做局部修补。
- 终端、登录、项目、编辑器、数据库结果区和 Agent 面板需要按新设计规格重新实现。

