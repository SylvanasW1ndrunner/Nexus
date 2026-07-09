# BetaV0.1.1 官方插件工具策略诊断

## 变更

- 官方插件 runtime tool 解析支持结构化拦截原因。
- Agent/Skill 工具白名单策略支持区分插件策略拦截和 Skill 收窄拦截。
- desktop headless Agent 服务的工具策略预览返回诊断 DTO。
- 补充 core-tools 与 desktop 服务测试。

## 验证

- core-tools、shared、desktop 类型检查通过。
- 官方插件 registry 和 tool policy 测试通过。
- desktop Agent service 测试通过。
- touched files ESLint 通过。

## 发布备注

该变更不改变用户可执行工具集合，只提高后端诊断能力。后续 UI 重建时，插件市场、Agent 调试面板和项目设置可以直接展示这些诊断字段。
