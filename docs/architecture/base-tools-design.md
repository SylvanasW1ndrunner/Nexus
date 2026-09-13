# 基础 Tool 设计

本文定义通用 Agent 的内部基础 Tool 边界。Tool 通过统一 Runtime 执行，并按每次操作静态声明工作区写入、
联网、外部写入、破坏性、管理员或高风险事实。

## 授权

唯一的产品授权机制是全局 config.toml 中的 default、auto、full-access 和企业规则。default 对互联网
访问和工作区外编辑要求批准；auto 只对静态高风险动作和企业规则要求批准；full-access 不自动拦截
动作等待批准。项目、Skill、MCP 和 Capability 都不能提高权限。require_sandbox 若存在，只是全局
企业执行规则。

## 内容与输出边界

Runtime 不识别敏感信息、不脱敏、不拦截类似凭据的命令参数，也不判断第三方 CLI、Skill、MCP 或
Capability 是否可信。Tool 结果、stdout/stderr、Provider 错误、Journal、Artifact 和 retention
使用普通大小、取消和生命周期约束，可保留原始内容。用户负责输入、端点、外部工具和输出的敏感性。

## 执行

所有 Tool 经过 prepare、authorize、schedule、execute、observe。只有命令型 Capability 使用 Host-owned
argv Port，且不使用 shell fallback。基础 process_exec 保留用户提供 shell command 的执行合同；Capability
按任务动态发现，但与基础 Tool 共用同一授权和执行主干。

## 结果文件

始终加载的基础 Tool 基线为 14 个。结果消费相关 Tool 的注册顺序固定为 `result_read`、
`result_materialize`、`result_save`：前者只把受控结果的有界页面交给模型查看；
`result_materialize` 将同一 `contentRef` 的原始字节流复制为仅本次 Run 可读的临时文件；
`result_save` 才会把原始字节显式写入项目工作区作为持久文件。它们不属于 Database 或其他
Capability，也不能决定 Run 是否继续或结束。

`result_materialize` 的目标位于项目内 `.schemanaut/runtime/materialized/`，路径不可预测且为
Run-scoped。同一 Run 对同一引用重复调用复用已校验文件；Run 进入 completed、failed、cancelled、
limit_reached 或 interrupted 终态后清理，Host 后续启动也会回收崩溃遗留的终态、无主或元数据损坏目录。
它只声明 Runtime 内部读取事实（`access=read`、`recoveryClass=read`），没有外部写入，也不产生用户产物。

`result_save` 只可在用户明确要求保存、导出、保留或生成文件时调用。此规则是 Agent 的显式行为合同，
不是通过关键词或内容扫描强制自然语言意图，也不是第四种权限模式。持久写入仍统一适用既有的
default、auto、full-access 与全局 `config.toml` 规则；v1 仅允许项目工作区内 create-only、no-replace
保存，已有目标返回 typed conflict，绝不隐式覆盖。

## 工作区条件写

`workspace_apply_patch` 是始终加载的基础 Tool，不能在标准本地 Host 中只返回“后端不可用”再迫使模型
用 shell 拼接写文件。Agent Host 默认组合 Node 本地文件 Primitive 和 Core Tools 的
`workspace-mutation-cas.v1` 状态机：创建使用独占文件、发布使用 no-replace 硬链接，更新和删除先保留
同一文件身份的备份，事务阶段写入项目内 Journal，并在每个阶段重验规范父目录和目标身份。

该 Primitive 只接受已经存在的真实父目录和普通文件；符号链接、reparse point、目录目标或身份变化
返回 typed failure。它是本地文件一致性实现，不是沙盒或内容安全层，也不改变 default、auto、
full-access 和企业规则。文件系统缺少所需的独占创建、硬链接或持久化能力时，操作应明确失败，不能
静默退回不具备条件写语义的普通覆盖。
