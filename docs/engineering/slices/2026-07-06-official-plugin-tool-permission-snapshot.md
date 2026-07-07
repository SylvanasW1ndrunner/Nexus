# 官方插件工具权限快照切片

## 背景

官方插件 registry 已经能根据插件启用状态、Skill `allowedTools` 和 runtime tools 生成 Agent 可用工具白名单。下一步需要把该白名单变成可审计的权限快照，并修补静态工具只按名称匹配的边界。

本切片目标是让官方插件、未来第三方插件、MCP 工具和 workspace script 工具共用同一套权限解释路径：工具能不能进 Agent，不只看名字，还要看来源、风险、只读属性和插件声明权限。

## 实现范围

- `packages/core-tools/src/official-plugin-registry.ts`
  - `resolveToolContributions()` 额外保留静态工具贡献对象。
  - 静态工具匹配改为 tool name + runtime source。
  - 动态工具不能接管与官方静态工具同名的 runtime tool。
  - 默认官方静态工具声明 `database`、`schema-rag`、`workspace` runtime source。
- `packages/core-tools/src/official-plugin-tool-policy.ts`
  - `resolveOfficialPluginAgentTools()` 新增 `toolPermissions`。
  - 权限快照包含插件、贡献项、runtime source、风险等级、只读标记、审批策略、资源范围、网络/进程访问和 secret 类型。
- `packages/shared/src/ipc.ts`
  - `AgentToolPolicyPreview` 暴露 `toolPermissions`，供无 UI 调用和未来前端设置页复用。
- `apps/desktop/src/main/agent-service.ts`
  - Headless Agent policy preview 同步返回权限快照。

## 安全边界

- MCP 或市场插件即使暴露 `query_database` 这样的同名工具，也不能绕过官方数据库工具边界。
- Skill 仍只能收窄权限，不能扩大插件和 runtime 策略允许的工具集合。
- `toolPermissions` 只描述最终进入 `ReactAgent.run({ allowedTools })` 的工具，不描述被拦截工具，避免上层误授权。
- 该切片不启动 MCP、不安装插件、不访问网络，也不改变具体 tool handler 的执行权限兜底。

## 测试

- `official-plugin-registry.test.ts`
  - 覆盖官方静态工具 source 匹配。
  - 覆盖 user MCP 同名冒充 `query_database` 被阻断。
- `official-plugin-tool-policy.test.ts`
  - 覆盖 Agent 工具权限快照。
  - 覆盖 Skill 声明同名伪装工具时最终 allowed tools 为空。
- `skill-agent-runner.test.ts` / `auto-skill-agent-runner.test.ts`
  - 复验 Skill runner 仍只把最终交集传给 Agent。

## 后续

- 后续插件市场安装流程应复用该权限快照作为安装确认和 Agent 运行审计的数据源。
- MCP market adapter 接入后，需要把市场来源、server id 和原始 tool name 填入 runtime descriptor。
- 若引入第三方插件进程，应在同一权限模型上增加插件包来源、签名或校验摘要。
