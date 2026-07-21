# 分模块开发文档

本目录记录 DBAgent 各模块的实际开发逻辑、代码入口、关键决策、测试覆盖和后续扩展点。`../modules.md` 保留总体原则和边界，本目录按模块展开，便于开发、验收和后续接手。

## 阅读顺序

1. [shared 契约与导出模块](./shared.md)
2. [core-db 数据库核心模块](./core-db.md)
3. [core-rag Schema RAG 模块](./core-rag.md)
4. [core-agent Agent 执行模块](./core-agent.md)
   - [core-agent 行为评估与工具证据](./core-agent-behavior-evaluation.md)
5. [core-llm 大模型接入模块](./core-llm.md)
6. [core-tools 工具与诊断模块](./core-tools.md)
   - [core-tools Agent/RAG Eval Suite Runner](./core-tools-agent-eval-suite.md)
7. [workspace / Python 模块](./workspace-python.md)
8. [core-skills 与开发 Skill 模块](./development-skills.md)
9. [sdk Headless Runtime 模块](./sdk-runtime.md)
10. [server、CLI 与参考 WebUI 模块](./server.md)
11. [desktop 桌面应用模块（保留路线）](./desktop.md)
12. [auth / usage / llm 支撑模块](./supporting-core.md)
13. [scripts 工程脚本模块](./scripts.md)

## 维护规则

- 新增 IPC channel、driver 方法、结果结构、Tool Registry 合约、Plugin Registry 合约或打包规则时，必须同步更新对应模块文档和 `../interfaces.md`。
- 新增业务场景测试时，必须同步更新 `../test-strategy.md` 或对应切片验收报告。
- 涉及 Agent、RAG、MCP、SQL parser、embedding、Python、terminal、packaging 的能力，必须在模块文档或 release note 中记录开源优先评估。
- 能进入插件市场的能力，必须记录官方插件候选判断、plugin id、权限 manifest、生命周期和 registry 映射。
- 文档使用中文；代码标识符、路径、命令、IPC channel、错误码和包名保持英文。
