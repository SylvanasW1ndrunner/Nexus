---
name: dbagent-acceptance-scenario-testing
description: Use when designing or implementing DBAgent/Nexus realistic acceptance tests from product scenarios, including backend workflows, real PostgreSQL, Python, terminal, LLM-gated, MCP, persistence, recovery, and packaging smoke paths.
---

# DBAgent 验收场景测试

用于把产品文档中的真实用户旅程转成可执行测试。重点验证产品链路可用，而不是只验证函数返回值。

## 场景来源

优先从这些文档抽取测试场景：

- `docs/product/06-classic-features.md`：数据库 IDE 基础能力。
- `docs/product/02-rag-design.md`：Schema RAG、索引、检索质量。
- `docs/product/03-agent-design.md`：Agent loop、工具调用、权限确认。
- `docs/product/04-config-design.md`：配置、Provider、密钥、MCP。
- `docs/product/08-workspace-design.md`：Workspace、Python、脚本制品。
- `docs/product/09-error-recovery.md`：崩溃恢复、重试、取消、诊断。
- `docs/product/10-usage-and-subscription.md`：认证、用量、订阅骨架。

## 测试分层

- 纯单元测试：确定性算法、解析、过滤、格式转换。
- 服务集成测试：主责 core 包、主进程服务、持久化和错误边界。
- 真实依赖测试：PostgreSQL、Python、终端、MCP、LLM、Embedding，通过环境变量或本地服务门控。
- 打包冒烟测试：验证 release 产物关键路径可启动、依赖可加载、原生模块可用。

## 场景写法

每个验收场景必须写清：

- 用户任务：用业务语言描述。
- 初始状态：数据库、workspace、配置、登录状态、文件或进程状态。
- 操作入口：服务方法、IPC、脚本、CLI 或测试 harness。
- 期望结果：数据、事件、日志、错误码、恢复状态。
- 失败保护：不会误执行危险 SQL、不会泄露凭证、不会污染用户文件。

## 真实依赖规则

- PostgreSQL 测试必须覆盖连接成功、连接失败、网络中断、事务回滚、复杂 SQL、EXPLAIN 或性能边界。
- Python 测试必须覆盖解释器检测、venv/conda 选择、脚本输出、异常、取消和产物保存。
- 终端/子进程测试必须覆盖输入输出、关闭、重启、工作目录和不可用 shell。
- LLM/Embedding 测试必须在缺少 key 时跳过并说明门控条件；有 key 时跑真实模型。
- MCP 测试必须覆盖启动失败、工具超时、单 server 失败不影响其他工具。

## 验收输出

实现或修改测试后，记录：

- 测试文件路径。
- 覆盖的产品场景编号或文档段落。
- 本地已运行命令。
- 未运行的真实依赖测试及原因。
- 发现的产品或实现缺口。

## 质量标准

测试不能只证明 happy path。每个核心功能至少覆盖一个失败路径、一个边界路径和一个恢复或清理路径。
