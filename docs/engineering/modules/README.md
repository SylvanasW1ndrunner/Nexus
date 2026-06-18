# 分模块开发文档

本目录记录 M0-M1.5 阶段各模块的实际开发逻辑。`../modules.md` 保留总体原则和边界，本目录按模块展开到代码入口、关键决策、测试覆盖和后续扩展点，便于验收和后续接手。

阅读顺序建议：

1. [shared 契约与导出模块](./shared.md)
2. [core-db 数据库核心模块](./core-db.md)
3. [core-agent Agent 执行模块](./core-agent.md)
4. [core-llm 大模型接入模块](./core-llm.md)
5. [core-tools 工具与诊断模块](./core-tools.md)
6. [desktop 桌面应用模块](./desktop.md)
7. [auth / usage / llm 支撑模块](./supporting-core.md)
8. [scripts 工程脚本模块](./scripts.md)

维护规则：

- 新增 IPC channel、driver 方法、结果结构或打包规则时，必须同步更新对应模块文档和 `../interfaces.md`。
- 新增业务场景测试时，必须同步更新 `../test-strategy.md`。
- 文档使用中文；代码标识符、路径、命令和错误码保持英文。
