# BetaV0.1.1 开发过程 Skills

## 新增能力

此前已新增 6 个项目级开发 skill，用于约束当前“先完成核心功能、最后统一开发前端 UI”的开发模式：

- `dbagent-backend-slice-execution`
- `dbagent-contract-ipc-development`
- `dbagent-real-integration-testing`
- `dbagent-docs-sync-development`
- `dbagent-dependency-packaging-review`
- `dbagent-release-version-discipline`

本次继续补充 3 个过程型 skill：

- `dbagent-development-skill-router`：开发任务开始前选择对应产品文档和模块 skill。
- `dbagent-module-doc-authoring`：规范模块级中文工程文档、接口说明和测试说明。
- `dbagent-regression-matrix-maintenance`：维护跨模块验收矩阵和回归测试清单。

同时为以下已有 skill 补齐 `agents/openai.yaml`：

- `dbagent-agent-tooling-development`
- `dbagent-auth-config-usage-development`
- `dbagent-workspace-python-release-development`

## 影响范围

- 仅新增/补齐 `skills/` 下的开发流程约束和元数据。
- 更新 `docs/engineering/development-skills.md` 作为开发过程 skill 索引。
- 不改变产品代码、IPC、主进程服务或 renderer UI。

## 验证命令

```powershell
C:\Users\cdnzx\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe -X utf8 C:\Users\cdnzx\.codex\skills\.system\skill-creator\scripts\quick_validate.py skills\dbagent-development-skill-router
C:\Users\cdnzx\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe -X utf8 C:\Users\cdnzx\.codex\skills\.system\skill-creator\scripts\quick_validate.py skills\dbagent-module-doc-authoring
C:\Users\cdnzx\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe -X utf8 C:\Users\cdnzx\.codex\skills\.system\skill-creator\scripts\quick_validate.py skills\dbagent-regression-matrix-maintenance
rg "模板占位残留关键字" skills\dbagent-development-skill-router skills\dbagent-module-doc-authoring skills\dbagent-regression-matrix-maintenance
```

## 已知限制

- 官方 `quick_validate.py` 在 Windows 默认 GBK 环境下读取中文 UTF-8 文件会失败，需要使用 `python -X utf8`。
- 本次只补充开发流程 skill，不执行产品功能实现。
