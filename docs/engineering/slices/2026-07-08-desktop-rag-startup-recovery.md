# 2026-07-08 桌面启动期恢复活跃 Schema RAG 快照

## 背景

Schema RAG 已具备快照保存、读取、清理无主文件和桌面启动期清理能力。但如果应用重启后只清理快照、不把活跃连接快照加载回共享 RAG 引擎，Agent 工具仍然会在冷启动阶段表现为没有索引，无法发挥持久化快照的价值。

本切片补齐启动期恢复链路：清理无主快照后，自动 hydrate 活跃连接快照。

## 实现内容

- 扩展 `apps/desktop/src/main/schema-rag-startup-cleanup.ts`：
  - 新增 `recoverSchemaRagSnapshotsAtStartup()`。
  - 保留原 `cleanupSchemaRagSnapshotsAtStartup()`，避免已有测试和调用方语义变化。
- `recoverSchemaRagSnapshotsAtStartup()` 流程：
  1. 读取当前连接清单。
  2. 调用 `cleanupInactive()` 删除无主和损坏快照。
  3. 对每个活跃连接调用 `loadDetailed(connectionId)`。
  4. 对 `loaded` 快照调用共享 `SchemaRagEngine.loadIndex()`。
  5. 汇总 loaded/missing/invalid/error 计数。
- `main.ts` 启动期改为调用恢复服务，并在有恢复、清理或错误摘要时写入 `main.log`。

## 恢复与失败语义

- 连接清单读取失败：整体跳过恢复，由 `main.ts` 记录错误并继续启动。
- 清理阶段失败：记录 `cleanupError`，继续尝试恢复活跃连接快照。
- 单个连接快照缺失：计为 `missing`，不算错误。
- 单个连接快照损坏或读取失败：计入 failed connection，不影响其他连接恢复。
- `SchemaRagEngine.loadIndex()` 抛错时，按该连接恢复失败处理，应用继续启动。

## 安全边界

- 日志只记录计数、连接 ID 和错误摘要，不记录快照内容、数据库密码、API key 或 SQL。
- 快照文件的删除范围仍由 `SchemaRagSnapshotStore` 限定。
- 恢复只针对当前连接清单中的连接，不跨连接共享 RAG。

## 开源方案评估

本轮没有新增依赖。

- 当前能力是已有 JSON 快照的生命周期恢复，不涉及新检索算法或向量存储。
- `SchemaRagEngine.loadIndex()` 和 `SchemaRagSnapshotStore.loadDetailed()` 已提供稳定 adapter 边界。
- 引入 LlamaIndex、LangChain、sqlite-vec 或 SQLite adapter 不会改善本切片目标，反而增加 Electron 打包和迁移风险。

## 测试

新增/扩展 `apps/desktop/src/main/schema-rag-startup-cleanup.test.ts`：

- 清理后把活跃连接快照加载进共享 RAG 引擎。
- 某个连接快照缺失或损坏时，其他连接仍能恢复。
- 清理阶段失败时，仍然尝试 hydrate 活跃连接快照。

已运行：

```powershell
pnpm exec vitest run apps/desktop/src/main/schema-rag-startup-cleanup.test.ts
pnpm turbo typecheck --filter=@dbagent/desktop
pnpm turbo lint --filter=@dbagent/desktop
pnpm turbo test --filter=@dbagent/desktop
pnpm turbo typecheck
pnpm turbo lint
pnpm turbo test --concurrency=1
pnpm smoke
git diff --check
```

结果：全部通过。提交前 secret 扫描没有命中测试 API key。

## 后续扩展

- 把启动恢复摘要加入诊断报告，但继续避免包含快照内容。
- 为 SQLite/sqlite-vec 存储层保留同一恢复合同。
- 后续可在 Agent 工具执行前检查 `getIndexStatus()`，对 missing 连接触发后台重建。
