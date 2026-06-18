---
name: dbagent-headless-capability-validation
description: Use when validating that a DBAgent/Nexus backend or core capability is usable before the final frontend UI exists, through core services, typed IPC, preload contracts, CLI/test harnesses, fixtures, scripts, or packaged smoke checks.
---

# DBAgent 无界面能力验收

用于当前“先完成所有核心功能，最后统一重建前端”的开发模式。任何能力都必须能脱离最终 UI 被验证，否则不能算完成。

## 适用场景

- 新增 core 包能力，需要证明未来 UI 只是接线层。
- 新增 IPC、main service、preload API，需要验证类型合同和错误行为。
- 新增数据库、RAG、Agent、MCP、Python、workspace、auth、usage 功能，但 UI 尚未开发。
- 准备提交或发版前，需要确认没有依赖旧 renderer UI。

## 必读文档

- 开发路径和模块边界：`docs/product/05-development-guide.md`
- 总体产品形态：`docs/product/00-overview.md`
- 相关模块产品文档：`02`、`03`、`04`、`06`、`08`、`09`、`10`
- 当前工程文档：`docs/engineering/`

## 验收入口优先级

1. Core package exported API。
2. Main-process service 方法。
3. Typed IPC contract 和 preload 暴露方法。
4. Test harness、fixture script 或命令行入口。
5. 打包 smoke test。

不要把最终 React UI、旧 App.tsx、旧项目树、旧 Agent panel 或旧终端面板作为验收入口。

## 验收流程

1. 写清用户任务：用户最终能完成什么。
2. 找到最小无 UI 调用路径：service、IPC、脚本或测试入口。
3. 准备真实输入：数据库连接、workspace、配置、脚本、MCP server 或 provider gate。
4. 执行成功路径，并检查输出、事件、持久化文件、日志和状态变化。
5. 执行失败路径：无效输入、权限拒绝、超时、取消、网络中断、配置损坏。
6. 记录验证命令和剩余限制到中文工程文档或 release note。

## 必须证明的能力

- 对外合同稳定：类型导出、IPC request/response、错误码、事件结构。
- 状态可观察：调用者能知道 running、done、failed、cancelled、degraded。
- 数据可恢复：持久化能力有原子写、事务或恢复说明。
- 安全可控：无明文密钥出边界，无危险操作静默执行。
- 打包可行：依赖路径、二进制、子进程和资源文件不依赖开发目录。

## 输出格式

```markdown
## 无界面验收

用户任务：

验收入口：

调用步骤：

成功断言：

失败断言：

持久化/日志：

已运行验证：

剩余限制：
```
