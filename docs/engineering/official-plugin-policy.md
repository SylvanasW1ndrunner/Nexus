# 官方插件化策略

DBAgent 的长期架构目标不是把所有能力堆进主程序，而是形成稳定平台加插件生态。当前阶段即使先做后端能力，也要从一开始判断哪些能力适合沉淀为官方插件。

## 目标

- 保持主程序轻量、模块化、可测试。
- 让官方能力和未来第三方插件使用同一套合约。
- 通过官方插件反向验证插件市场、权限模型、生命周期和打包策略。
- 减少后期从内置功能迁移到插件体系的返工。

## 适合官方插件化的能力

优先考虑以下特征：

- 可以独立安装、启用、禁用、升级或卸载。
- 可以通过 Tool Registry、Skill Registry、MCP adapter、workspace script tool 暴露。
- 有清晰权限边界，例如读取 schema、执行 SQL、访问文件、运行进程、调用网络。
- 有独立生命周期，例如 install、enable、disable、health、uninstall。
- 可能被第三方替换或扩展，例如 SQL 优化器、导出器、RAG eval、数据分析脚本、诊断工具。

当前官方插件候选：

- `official.schema-rag-eval`：Schema RAG 检索质量评估。
- `official.sql-optimizer`：SQL 性能分析和优化建议。
- `official.schema-doc-generator`：Schema 文档生成。
- `official.er-diagram-generator`：ER 图生成。
- `official.python-data-analysis`：Python 数据分析脚本工具集。
- `official.postgres-diagnostics`：PostgreSQL 连接、权限、慢查询和配置诊断。
- `official.result-exporters`：CSV、Excel、JSON、Parquet 等结果导出。
- `official.mcp-stdio-adapter`：stdio MCP server 安装、启动、工具归一化和健康检查。

## 强制合约

官方插件不能绕过平台合约，至少包含：

- `id`、`name`、`version`、`source`。
- 权限 manifest 和危险等级。
- Tool schema 和 result schema。
- 生命周期：install、enable、disable、health、uninstall。
- 审计字段：调用方、工具名、参数摘要、耗时、状态、脱敏错误。
- 配置字段：非 secret JSON 加 keychain secret ref。
- 测试入口：单元测试、真实依赖集成测试、失败和恢复测试。

## 实现原则

- 平台层维护 registry、权限、审计、配置、生命周期、超时、日志脱敏和错误归一。
- 插件层实现具体能力。
- 官方插件使用与第三方插件一致的 public contract，不允许硬编码特权路径。
- 如果为了早期开发先以内置模块实现，也必须保留迁移到官方插件的边界：adapter、manifest、registry mapping 和测试 fixture。

## 开源借鉴要求

每个官方插件候选在实现前必须评估该领域优秀开源项目：

- 读取官方仓库、官方文档、许可证、打包说明和维护状态。
- 至少比较成熟依赖、小型依赖/平台能力、本地自研三类路径。
- 记录可复用设计，例如 lifecycle、tool schema、eval 指标、index strategy、process supervision。
- 记录不可直接复用原因，例如许可证、Electron 打包、离线行为、native module、API 不匹配、安全边界或产品差异化。
- 最终实现必须说明 DBAgent 做了哪些优化和扩展，而不是简单照搬。

## 验收标准

- 官方插件候选可以被非 UI 调用方发现、启用、禁用和验证健康状态。
- 权限和审计路径被测试覆盖。
- 失败不会拖垮主程序或其他工具。
- secret 不进入 renderer、Agent context、日志、文档或提交历史。
- 打包影响和离线行为有记录。

