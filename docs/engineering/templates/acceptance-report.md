# 用户级验收报告模板

## 验收对象

- 功能切片：
- 版本/分支：
- 提交范围：
- 变更模块：
- 触达测试目录：
- 验收日期：
- 验收角色：测试 Agent

## 用户场景

- 目标用户：
- 真实工作流：
- 输入数据：
- 外部依赖：

## 测试环境

- 操作系统：
- Node/pnpm：
- Docker：
- PostgreSQL：
- Python/conda/venv：
- LLM provider/model：
- Electron 打包产物：
- ASAR 状态：

## 执行命令

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm smoke
pnpm test:postgres
pnpm test:agent-rag-live
pnpm package
pnpm package:verify
```

## 结果

- 默认门禁结果：
- 外部依赖门禁结果：
- 功能可用性：
- 失败场景是否清晰：
- 性能观察：
- 安全观察：
- 恢复能力：
- 打包影响：

## 分域验收

- PostgreSQL：连接参数脱敏、数据库版本、fixture 来源、是否重建隔离库、失败/跳过原因。
- Agent/RAG：供应商、模型、真实 tool-call 证据摘要、RAG 命中情况、失败 case、token/耗时。
- Python/终端：系统 Python、venv、conda、shell/PTY、打包后 `node-pty` 是否验证。
- 打包：打包命令、产物路径、ASAR/非 ASAR 状态、启动探活、原生模块加载、是否跳过 GUI。
- 安全：密钥注入方式、日志/快照无密钥、测试库销毁范围确认。

## 未覆盖项

- 未运行测试：
- 原因：
- 替代验证：
- 残余风险：
- 负责人：

## 结论

- 验收结论：通过 / 有条件通过 / 不通过
- 阻塞项：
- 必须修复：
- 后续建议：

