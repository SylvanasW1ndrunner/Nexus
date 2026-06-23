# BetaV0.1.1 - Agent 会话持久化

## 背景

产品文档要求 Agent 会话支持历史加载、列表、更新、删除、分叉、归档和导出。此前 `core-agent` 只有运行期 session 对象和 checkpoint store，能支持崩溃恢复识别，但不能作为用户长期回看和后续 Agent 面板的数据来源。

本切片补齐 Agent 会话历史的后端合同，不涉及前端 UI。

## 本次变更

- 新增 `packages/core-agent/src/session-store.ts`。
- 新增 `AgentSessionStore`：
  - `save()`
  - `load()`
  - `list()`
  - `update()`
  - `archive()`
  - `delete()`
  - `fork()`
  - `export()`
- `ReactAgent` 新增可选 `sessionStore` 依赖。
- Agent 运行过程中在以下节点保存会话：
  - 用户消息创建后。
  - assistant 消息返回后。
  - tool result 写入后。
  - 工具拒绝、未注册工具、allowedTools 拦截、权限拒绝后。
  - 完成、中止、迭代上限、token budget 和异常路径。
- `index.ts` 导出 session store 相关类型和实现。

## 用户场景

- 用户完成一次分析后，后端能列出会话摘要并加载完整历史。
- 用户可以把一次会话导出为 JSON 或 Markdown，用于审计、问题反馈或二次分析。
- 用户可以把旧会话从某条消息分叉，保留前文并重新尝试不同方向。
- 用户归档会话后，默认列表不再显示；需要时仍可按 `archived: true` 查询。
- 应用启动遇到损坏 session JSON 时，会话列表按空数据降级，避免影响应用启动和其它能力。

## 开源依赖决策

本切片不新增 SQLite、ORM 或其它持久化依赖。原因：

- 当前阶段目标是先稳定 `core-agent` 会话合同和用户行为。
- JSON 原子写入可在无外部依赖下覆盖 beta 阶段的本地单用户会话历史。
- `core-agent` 需要保持 Electron 无关，方便单测和后续服务端/CLI 复用。

后续当会话历史达到高并发、大体量、全文检索或跨模块复杂查询需求时，应迁移到 SQLite WAL，并按 `docs/engineering/open-source-first.md` 记录 SQLite wrapper、ORM、迁移工具、SQLCipher、打包和恢复策略评估。

## 测试

- `packages/core-agent/test/session-store.test.ts`
  - 保存、加载、列表、更新、归档、恢复、删除。
  - 标题/消息搜索和分页。
  - 从指定消息分叉会话。
  - JSON / Markdown 导出。
  - 缺失会话和非法分叉位置返回明确错误。
  - 损坏 JSON 按空会话降级。
  - `ReactAgent` 跑完一次带工具调用的分析后，会话历史可从 store 读取。
- `packages/core-agent/test`
  - 全量回归现有 permission、checkpoint、context、RAG tools、ReactAgent 行为。

## 验证命令

```powershell
node .\node_modules\typescript\bin\tsc -p packages\core-agent\tsconfig.json --noEmit
node .\node_modules\typescript\bin\tsc -p packages\core-agent\tsconfig.json
node .\node_modules\vitest\vitest.mjs run packages\core-agent\test
```

## 已知边界

- 当前使用 JSON 文件，不适合长期高并发写入和大规模历史全文检索。
- 当前 `ReactAgent` 保存的是完整 session 快照，后续 SQLite 版本应拆成 sessions/messages/tool_calls 表。
- 当前未新增 IPC；桌面端后续可把 `session:list/load/fork/delete/export` 接到主进程合同。
