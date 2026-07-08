# 2026-07-08 Schema RAG 快照清单与过期清理

## 背景

Schema RAG 已支持连接级快照保存、恢复和按连接删除。但实际产品使用中，用户可能在连接配置损坏、连接被批量删除、配置迁移或工作区切换后留下旧快照。如果没有清单和清理接口，应用启动时无法审计本地 RAG 占用，也无法根据当前连接集合安全清理无主快照。

本切片补齐 `core-rag` 的快照生命周期能力，不涉及 UI。

## 实现内容

- `SchemaRagSnapshotStore.list()`
  - 扫描 `rootDir` 下的正式快照文件。
  - 返回可用快照 summary：`connectionId`、`snapshotPath`、`savedAt`、`indexedAt`、文档/表/列/关系/glossary 数量。
  - 对损坏 JSON、旧版本或结构不合法的快照返回 `status: "invalid"`，不抛异常。
- `SchemaRagSnapshotStore.cleanupInactive()`
  - 输入当前仍存在的连接 ID 集合。
  - 删除不在活跃集合中的快照。
  - 可选 `removeInvalid: true` 删除损坏快照。
  - 返回 `kept` 与 `removed`，供上层诊断日志或后续设置页展示。

## 安全边界

- 清理只处理 `rootDir` 下文件名以 `.schema-rag.json` 结尾的文件。
- 不递归删除目录，不处理临时文件，不使用用户传入路径拼接删除任意位置。
- `activeConnectionIds` 会复用现有 connection id 校验，空字符串会被拒绝。
- 损坏快照默认保留，只在调用方明确设置 `removeInvalid: true` 时删除。

## 开源方案评估

本轮没有新增第三方依赖。

- 当前能力是快照文件清单和生命周期管理，不需要引入数据库或向量存储。
- SQLite/sqlite-vec 更适合后续长期索引存储和检索性能优化，但会带来 native module、打包、跨平台和迁移成本。
- LlamaIndex、LangChain 等框架的 storage abstraction 有参考价值，但它们的类型和运行时依赖不应进入当前稳定合同。

当前采用 Node 原生 `fs/promises`，保持 core 包轻量、离线可用、打包无新增风险。

## 测试

新增 `packages/core-rag/test/schema-rag-snapshot-store.test.ts` 覆盖：

- 真实临时目录中保存快照后列出 summary。
- 非快照文件不会进入清单。
- 损坏快照以 invalid summary 返回，不阻塞清单读取。
- `cleanupInactive()` 删除已删除连接的快照，并保留活跃连接快照。
- `removeInvalid: true` 时删除损坏快照。

已运行：

```powershell
pnpm exec vitest run packages/core-rag/test/schema-rag-snapshot-store.test.ts
pnpm turbo typecheck --filter=@dbagent/core-rag
```

## 后续扩展

- 在桌面主进程连接删除 workflow 中调用 `SchemaRagSnapshotStore.remove()` 或 `cleanupInactive()`。
- 在应用启动恢复流程中读取 `list()`，生成 RAG 索引诊断。
- 进入 SQLite/sqlite-vec 存储层后，将清单和清理接口保留为稳定上层合同。
