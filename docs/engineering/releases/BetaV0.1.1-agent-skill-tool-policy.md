# BetaV0.1.1 Agent Skill 工具策略记录

## 背景

当前开发模式先完成无 UI 后端能力，再统一重建前端。Skill 机制已经能够从定义文件生成执行计划，并根据当前可用工具过滤 `allowed_tools`。本次补齐 Agent 运行时边界，避免该字段只停留在规划层。

## 变更范围

- `packages/core-agent` 的 `AgentRunOptions` 增加 `allowedTools`。
- `ToolRegistry.llmTools()` 支持按白名单输出 LLM tool schema。
- `ReactAgent.run()` 在两层执行策略中强制白名单：
  - 发送给 LLM 的工具列表只包含 `allowedTools` 内的工具。
  - 如果模型返回未授权工具调用，即使该工具已注册，也返回 `permission_denied`，并且不执行工具 handler。
- 保持原有权限矩阵不变：readonly、ask、auto、full-auto 仍由 `PermissionManager` 决策工具风险等级。

## 验收标准

- Skill 执行计划允许 `query_database` 时，LLM 请求中不能出现 `execute_sql`。
- 模型伪造或返回隐藏的 `execute_sql` 调用时，Agent 必须拒绝，且写操作 handler 不得执行。
- 原有只读模式、询问模式、工具失败恢复能力不回归。
- 该能力不依赖 renderer UI，可通过单元测试和后端集成测试验证。

## 测试记录

测试命令在本次提交前执行，结果以提交说明和终端记录为准：

- `vitest run packages/core-agent/test packages/core-skills/test --passWithNoTests`
- `tsc -p packages/core-agent/tsconfig.json --noEmit`
- `skills/dbagent-quality-gate-testing/scripts/validate_no_secret_patterns.ps1 -Root .`
