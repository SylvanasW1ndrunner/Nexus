# Agent Runtime、Journal 与 Session 合同

本文是开发者文档，描述内部稳定合同，而非公共 SDK。

## 运行主干

终端通过私有 Host 组合 AgentRuntime。AgentRuntime 协调模型、项目作用域设置、Tool、Skill、MCP、
Capability 和持久化依赖；终端只解析命令、显示有界活动并收集用户输入。

Run、Turn 和 Tool Invocation 是核心执行单位。Kernel 推进状态；Invocation Runtime 负责校验、
许可、调度、执行、观察和终态提交；Journal 是可恢复事实来源；Session 和终端活动是投影。

## 持久化与恢复

恢复 Run 时必须读取已提交事实，不能复制一个新的执行循环。取消、steering、批准、上下文压缩和
子 Agent 命令都进入同一耐久合同。对非幂等外部动作，结果未知时必须要求显式确认或风险重试授权。

关闭先停止新工作准入，再持久化中断、排空活动工作和依赖，最后关闭 Provider。被 Turn 或 Tool
捕获的依赖受 lease 保护，直至释放。

## 进程、取消与隔离

Host 必须如实报告其可证明的进程状态。原生 Windows 没有强 OS 沙盒时，命令自然退出可以报告退出
结果，但 containment 与完整进程树回收均是 unverified；取消或终止后无法证明停止的 descendant
仍是 unknown。本轮不以 Job Object 提供额外保证。

需要强隔离但 Host 无法提供时，Runtime 返回 unavailable；可由用户决定的未隔离执行返回
ask-unsandboxed。每种结果都必须进入 Journal 和 Tool 结果的稳定错误合同。
