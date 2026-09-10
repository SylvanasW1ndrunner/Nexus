# 验证策略与报告边界

验证以可观察合同为单位。工程报告必须记录实际运行的命令、完整结果、未运行项及其原因；不能将计划、
文档或局部运行表述为完整验收。

## 验证层

| 层 | 目标 |
| --- | --- |
| 静态合同 | 类型、包边界、依赖方向和无失效导入。 |
| 核心合同 | Journal、状态机、权限、Tool 调度、取消、恢复和结果保留。 |
| Host 组合 | 全局配置、项目 MCP、bundled Runtime、Session 和 Run。 |
| Capability | probe、外部选择、命令 Port、风险分类、脱敏与重试。 |
| 终端工作流 | init、配置、模型、Skills、MCP、批准、恢复和诊断。 |
| 真实环境 | 真实模型、数据库和外部 CLI；缺少前置条件必须如实记为未运行。 |

## 本轮验收重点

- 命令型 Capability 不直接使用 child_process，且 Windows npm .cmd 通过安全 launch descriptor 启动。
- Tool prepare 固定 Run policy mode/revision、目标和 sandbox 要求，execute 复核同一快照。
- 外部文件或登录状态变化后能够重新 probe；父 PATH 或环境变化要求重启 Host。
- 原生 Windows 的自然退出、取消和进程树状态只报告可证明事实；无强隔离时不伪造 containment。
- cargo、format、Playwright、notebook 与容器 daemon 的风险分类反映真实副作用和外部边界。
- 所有输出、诊断和报告遵守大小上限与脱敏要求。

## 执行与报告

开发任务先运行受影响包的类型检查和聚焦测试，再按风险扩大到 Host、终端、脚本合同和真实环境层。
Task 10 统一运行构建、类型检查、lint、完整测试、Capability runtime、确定性 Agent 验收和可用的
真实环境验收。报告应区分实际成功、失败和未运行，且不得包含密钥、Authorization 值、URL 用户信息
或完整连接串。
