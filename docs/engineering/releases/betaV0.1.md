# betaV0.1 测试版记录

> 发布日期：2026-06-08。Git tag：`betaV0.1`。产品版本：`0.1.0`。分支：`codex/m0-m1-foundation`。

## 定位

`betaV0.1` 是 DBAgent 的第一个主要测试版本，用于内部本地体验和 M0-M1.5 阶段验收。该版本已经具备桌面端 PostgreSQL 基础工作流：创建连接、连接数据库、浏览 Schema、执行 SQL、查看结果、查看历史、导出 CSV/JSON，并包含危险 SQL 确认、只读拦截、EXPLAIN 安全入口、远程连接错误分类和打包产物验证。

## 主要能力

- Electron 桌面应用骨架和三栏工作区。
- PostgreSQL 连接测试、保存、更新、删除、连接、断开。
- 密码由主进程凭证 vault 管理，renderer 不回填已保存密码。
- SQL 执行、结果表格、查询历史、CSV/JSON 导出。
- Schema 表/视图列表、表结构详情、主键和外键 metadata。
- 只读连接拦截写操作和 DDL。
- 可写危险 SQL 需要二次确认，写批次失败时事务回滚。
- 空 SQL 和 EXPLAIN 非只读输入在执行前返回校验错误。
- 远程连接认证、DNS、端口、超时、中断等错误分类。
- IPC 契约快照、模块文档、接口文档和测试策略文档。
- Windows unpacked 打包产物验证，包含 ASAR 内容、新鲜度、renderer 资源路径和启动探活。

## 验证记录

最近候选验证已通过：

```bash
pnpm run ci
pnpm test:postgres
pnpm package:dir
pnpm package:verify
```

`pnpm test:postgres` 使用真实 PostgreSQL fixture，不是 mock。`pnpm package:verify` 已确认打包后的 renderer 使用相对资源路径，避免 `file://` 下白屏。

## 本地打开

Windows unpacked 测试入口：

```text
C:\Users\cdnzx\Documents\Nexus\apps\desktop\release\win-unpacked\DBAgent.exe
```

默认本地 PostgreSQL fixture：

```text
Host: 127.0.0.1
Port: 5432
Database: dbagent_demo
Username: postgres
Password: postgres
SSL: false
```

## 已知限制

- 这是测试版，不是公开发布安装包。
- 应用图标仍为默认 Electron 图标。
- 安装包尚未做代码签名。
- `safeStorage` 不可用时的 base64 fallback 仅作为 M1.5 可用性兜底。
- 未包含完整 Playwright 桌面 E2E。
- 弱网、VPN、防火墙、云安全组、跨平台 keychain 仍需发布前人工 QA。
- Agent、RAG、MCP、Python 工作空间、多数据库正式接入和自动更新属于后续里程碑。

## 后续建议

从 `betaV0.1` 开始，后续每个测试版都应保留：

- tag。
- 中文版本记录。
- `pnpm run ci` 结果。
- 真实 PostgreSQL 验证结果。
- 打包产物验证结果。
- 已知限制和下一版本重点。
