# 模型、上下文与项目设置合同

## 配置所有权

模型连接、模型默认值和企业权限只来自全局 ~/.schemanaut/config.toml。项目 settings.json 只保存
项目 MCP 声明；Session 保存模型选择和工作事实。Capability 不得建立项目或程序内配置协议，项目、
Skill、MCP 与 Capability 不能覆盖全局权限。

全局权限模式是唯一授权来源：default 对互联网和工作区外编辑要求批准；auto 只对静态声明的高风险
动作和企业规则要求批准；full-access 不自动拦截动作等待批准。require_sandbox 若配置，属于全局
企业执行规则。

## 上下文与结果

Runtime 在 Turn 生命周期中编译 Session 历史、项目指令、Skill、Capability 贡献和 Tool 输出。结果、
stdout/stderr、Provider 错误、Journal 和 Artifact 可以保留原始内容，仅受通用大小和生命周期限制。
Runtime 不识别敏感信息、不脱敏、不拦截类似凭据的值，也不判断外部内容是否安全；用户负责这些内容的
敏感性。

## 权限快照

每个 Tool prepare 接收当前 Run 的 policy mode 和 revision。该快照用于静态操作事实、沙盒执行规则
和 execute 复核，不依赖项目级权限来源。
