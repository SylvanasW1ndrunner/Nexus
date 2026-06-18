---
name: dbagent-test-fixture-design
description: Use when designing or updating DBAgent/Nexus realistic test fixtures, business datasets, PostgreSQL schemas, workspace trees, Python scripts, MCP stubs, LLM-gated scenario matrices, or acceptance cases derived from docs/product.
---

# DBAgent 测试夹具设计

用于把产品文档中的真实用户场景变成可复用、可重建、可扩展的测试数据和验收矩阵。目标是验证产品链路，而不是只喂几个最简单样例。

## 场景来源

- 数据库基本盘：`docs/product/06-classic-features.md`
- Schema RAG 和检索质量：`docs/product/02-rag-design.md`
- Agent、工具、权限、Skill：`docs/product/03-agent-design.md`
- 配置、Provider、MCP、IPC：`docs/product/04-config-design.md`
- Workspace 和 Python：`docs/product/08-workspace-design.md`
- 错误恢复：`docs/product/09-error-recovery.md`
- 登录、用量、订阅：`docs/product/10-usage-and-subscription.md`
- 测试策略和标准数据集：`docs/product/05-development-guide.md` §6

## 夹具设计原则

- 使用真实业务结构：用户、订单、商品、退款、软删除、JSONB、枚举、外键、索引、视图、函数。
- 包含脏结构：无主键表、缩写列、缺注释表、错误命名、孤儿数据，用于测 RAG 和 Agent 鲁棒性。
- 包含安全字段：email、phone、phone_enc、id_card、token-like 文本，用于测脱敏和工具边界。
- 包含性能梯度：small 数据集用于 CI，large 数据集用于性能和长查询测试。
- 能重复构建和清理，不能依赖开发者本机残留状态。

## PostgreSQL 夹具要求

- DDL：schema、tables、views、indexes、foreign keys、comments、functions。
- 数据：small 至少覆盖 1 万行级别场景；large 用门控方式生成或导入。
- SQL 场景：JOIN、CTE、window function、JSONB、temp table、DDL、transaction、savepoint、rollback。
- 失败场景：权限不足、语法错误、连接断开、锁等待、statement timeout、cancel。
- 性能场景：EXPLAIN、缺索引、索引命中、大结果分页、流式导出。

## Workspace/Python 夹具要求

- 目录包含 `queries/`、`scripts/`、`docs/`、`outputs/`、`skills/`、`.dbagent/`。
- Python 脚本覆盖成功、stderr、非 0 退出、长输出、超时、依赖缺失、产物保存。
- SQL 文件包含 `@name`、`@description`、`@params`、`@tags`、`@connection` 元信息。
- `_drafts/` 内容必须用于验证不会进入 Agent/RAG 上下文。

## MCP/Agent/LLM 场景矩阵

- MCP：启动失败、工具超时、无工具、危险工具、secret env ref、单 server 失败不影响基础工具。
- Agent：询问模式、自动模式、只读模式；SELECT、写操作、危险 SQL、大表查询、用户拒绝。
- LLM-gated：无 key 默认 skip；有 key 时测试 tool call 行为、错误修复和多轮状态，不断言固定措辞。

## 输出格式

```markdown
## 测试夹具设计

覆盖产品场景：

夹具目录/文件：

数据模型：

真实依赖：

成功场景：

失败场景：

性能/规模场景：

清理策略：

门控环境变量：
```
