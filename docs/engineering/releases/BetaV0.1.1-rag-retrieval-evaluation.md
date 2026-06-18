# BetaV0.1.1 - Schema RAG 检索评估器

## 新增能力

本次在 `packages/core-rag` 增加 `evaluateSchemaRagRetrieval()`，用于从用户视角评估 Schema RAG 检索效果。

评估项支持：

- `mustInclude`：用户问题必须召回的表/字段/关系文档 ID。
- `shouldInclude`：建议召回项，用于观察质量但不阻断通过。
- `mustNotInclude`：不能召回的明显错误项。
- 每个 case 的召回 ID、缺失项、误召回项、must/should 命中率和通过状态。
- 汇总通过率、平均 must 命中率、平均 should 命中率。

## 开源评估

当前切片不引入 RAGAS、LlamaIndex、LangChain eval、向量库或 reranker 依赖。原因：

- 当前 `core-rag` 仍处于结构化 schema 词法检索阶段，需要先建立轻量、确定性、无 LLM 成本的质量基线。
- 第三方 RAG eval 多面向非结构化文档或 LLM judge，不直接匹配 schema ID must-hit 验收。
- 不新增依赖可避免当前打包、离线、许可证和 native module 风险。

后续接入 embedding、RRF、rerank、LLM judge 或向量存储时，必须按 `dbagent-dependency-packaging-review` 做开源组件评估。

## 影响范围

- 新增 `packages/core-rag/src/retrieval-evaluation.ts`。
- 扩展 `packages/core-rag/src/types.ts` 和 `packages/core-rag/src/index.ts` 导出。
- 新增 `packages/core-rag/test/retrieval-evaluation.test.ts`。
- 更新 `docs/engineering/modules/core-rag.md`。

## 验证

```powershell
C:\Users\cdnzx\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe node_modules\typescript\bin\tsc -p packages\core-rag\tsconfig.json --noEmit
C:\Users\cdnzx\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe node_modules\vitest\vitest.mjs run packages\core-rag\test
```

## 已知限制

- 当前评估器只评估 schema 文档 ID 召回，不评估最终 SQL 正确性。
- 当前不做 LLM judge，避免默认测试依赖 API key。
