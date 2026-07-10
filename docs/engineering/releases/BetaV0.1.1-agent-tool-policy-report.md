# BetaV0.1.1：Agent 工具策略预检报告

## 范围

本切片增强 Agent / Skill / 官方插件工具策略的可观测性和可测试性，不涉及前端 UI。

新增能力：

- Agent 工具策略预检报告。
- Skill runner 返回最终工具策略报告。
- AutoSkill runner 返回 preflight 和最终工具策略报告。
- 缺工具错误携带 preflight 报告。
- PermissionManager mode/danger/readonly 权限矩阵测试。

## 兼容性

- `runSkillAgent()` 和 `runAutoSkillAgent()` 返回值只新增字段。
- `NoMatchingSkillError` 新增只读诊断字段。
- 未新增运行时依赖。

## 验证结果

- `core-agent` 类型检查通过。
- `core-tools` 类型检查通过。
- 聚焦策略测试：5 个测试文件，23 个测试通过。
- `core-agent` 全量测试：19 个测试文件，125 个测试通过。
- `core-tools` 全量测试：27 个测试文件，165 个测试通过，4 个门控测试跳过。
- 本轮触及文件 ESLint 通过。

## 已知限制

- Desktop 真实用户审批桥接仍未完成。
- Skill 恢复路径还需要保留原始 Skill allowlist。
- 真实 LLM negative gate 待补。
