---
name: dbagent-docs-sync-development
description: Use when updating DBAgent/Nexus Chinese product, engineering, module, API, test, or release documentation so implementation and docs stay synchronized during backend-first development.
---

# DBAgent Docs Sync Development

Use this skill whenever a code change affects module behavior, public contracts, tests, architecture, release scope, or known limitations.

## Documentation Sources

- Product intent: `docs/product/`
- Module implementation notes: `docs/engineering/modules/`
- Release notes: `docs/engineering/releases/`
- API and IPC contracts: nearest module docs or dedicated engineering docs.
- Test evidence: package test files and quality-gate notes.

## Sync Flow

1. Identify the product section that just became implemented or changed.
2. Update the module doc with the actual code entry points and boundaries.
3. Update API/IPC docs if public contracts changed.
4. Add a release note for user-visible or milestone-relevant slices.
5. Add test documentation when behavior depends on real PostgreSQL, LLM providers, terminal/Python processes, or packaging.
6. Document known limitations explicitly; do not hide unfinished behavior.

## Writing Rules

- Write Chinese docs first.
- Keep docs factual and implementation-linked.
- Mention file paths, exported functions, IPC channels, storage locations, and env gates.
- Avoid marketing language.
- Do not mention AI/Codex authorship.
- Do not write secrets, real API keys, or credentials.

## Minimum Module Doc Content

- 模块职责
- 代码入口
- 对外合同
- 数据/凭证边界
- 失败与恢复策略
- 测试覆盖
- 当前限制

## Release Note Content

- 版本或分支
- 本次新增能力
- 影响范围
- 验证命令
- 已知限制
- 是否需要用户迁移或重新配置
