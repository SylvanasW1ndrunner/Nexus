# 结果、产物与可观测性

## 耐久事实与用户视图

Journal 记录 Run、Turn、Tool Invocation 和可恢复事实；Session 与终端活动从这些事实投影而来。
终端显示的是有界、可操作的活动和终态，而不是 Journal 内部结构、完整审计日志或模型推理。

Tool 的校验、许可、开始、进度、结果和观察按顺序提交。终端可在新的进程中恢复相同 Run 的活动，
无需重新驱动同一个 Agent 循环。取消或关闭终端不会删除已提交的事实。

## 结果和产物边界

Artifact Store 为项目生成的文件保留稳定引用；Tool 或 Capability 产生的大结果也应保存为受控的
结果引用。最终回答可携带这些引用，而不把文件内容、行集或内部诊断无界写回 Session 或模型上下文。

`result_read` 是把受控结果分段送回模型的基础 Tool，而不是再次生成一个新的大结果。它服务于模型的
有界检查；完整结果不应靠分页读回模型再由模型手工拼接文件。它返回的
`data` 是当前页的权威内容；结构化读取不重复附带同一页的文本 preview。Runtime 仍统一校验 Tool
输出，并按照当前模型最小输入窗口为单次 Tool 结果保留至多约 1/64 的上下文预算，同时设置固定
上限。页面装不下时 Agent 必须减小 `limit` 并继续使用 Runtime 签发的 `nextCursor`，不能绕过
Artifact Store 直接读取内部文件。这样既避免 `result_read` 被通用预览再次压缩，也不会让长结果
无界进入上下文。

`record` 模式在调用方省略 `limit` 时采用 40 条的保守默认页。模型可见结果必须把 `eof` 和
`nextCursor` 等导航字段放在批量 `data` 之前，使通用结果投影即使需要截短数据，也不会先丢失继续
分页所需的信息；`eof=false` 时下一次调用必须携带返回的精确 `nextCursor`，不能重新读取首屏。

Capability 结果不决定整个 Run 或对话的最终态。数据库 SQL、浏览器动作或其他 Capability 调用只需
返回本次调用的成功、失败、结果引用和必要诊断；它们不能要求自己成为任务最后一次 Tool 调用，也不能
注册跨调用的完成校验器。`result_read`、工作区写入和 Python 进程可以继续消费、转换和验证 SQL 结果，
是否继续执行或生成最终回答由通用 Agent Runtime 统一决定。

`result_materialize` 与 `result_save` 紧随 `result_read` 作为基础 Tool 注册，分别处理临时消费和持久
用户产物。`result_materialize` 在同一 Run 内把 owner ACL 保护的 `contentRef` 原始字节流物化为
`.schemanaut/runtime/materialized/` 下不可预测的 Run-scoped 临时相对路径；后续 `process_exec` 或本地
Tool 可读取该路径，媒体类型只用于保守的扩展名选择，内容绝不转码。因此数据库长结果仍是 NDJSON，
Python 可用标准库逐行处理。Store 必须在打开流前校验引用格式、host/session/run/project 所有权、revision、
过期、删除与校验和，调用方不能由 `contentRef` 推导或直接打开其物理存储路径。

物化文件在 Run 的 completed、failed、cancelled、limit_reached 或 interrupted 终态订阅者获得结果后安排
清理；正常关闭回收已结束 Run，后续 Host 启动会删除无对应 Run、已终态、owner 不匹配或元数据损坏的
遗留目录。即时删除因进程崩溃或 Windows 文件占用失败时，Runtime 记录待回收项并重试；这不影响已完成
的 Agent 结果。`result_materialize` 只是 Runtime 内部读取（`access=read`、`recoveryClass=read`），不代表
任务完成或用户保存。

`result_save` 是唯一的持久保存通道：它将原始字节 create-only、no-replace 地写入项目工作区，并返回
canonical path、字节数和摘要；现有目标返回 typed conflict。它只能响应用户明确提出的保存、导出、保留或
生成文件要求。该限制是 Agent 行为合同，不是自然语言策略/DLP 执行，也不增设授权模式；持久写入继续统一
经过 default、auto、full-access 与全局 `config.toml` 规则。持久文件不参与临时物化目录的终态或启动回收。

Runtime 可以对所有模型统一识别“我接下来会读取/获取/运行/检查/分析……”这类把待执行动作误写成最终答复的
非终态文本，并要求模型继续执行；该规则只判断最终文本是否真的在交付结果，不绑定任何 Capability、
工具名称或调用顺序。
分页或分批任务中，“第 N 页/批已完成，继续下一页”这类进度便签同样不是最终交付；Runtime 可按通用
进度语义要求继续，但不能检查某个 Capability 是否最后被调用。

Runtime 签发和校验结果引用的所有权、存在性、revision 与生命周期，保证引用本身可用；这属于通用
结果基础设施，不赋予任何 Capability 对 Run 完成状态的裁决权。

Capability 返回给 Runtime 的内联结果和保留结果都必须先归一化为公共 `PortableValue`。数据库日期、
二进制值和驱动专用对象不能原样泄漏到 Tool 结果；存在会话时区时，日期按该时区投影为无偏移的本地
ISO-8601 文本，否则使用规范 UTC ISO-8601 文本。此转换只定义本次调用的结果契约，不影响后续 Tool
调用或 Run 的完成判断。

数据库结果属于数据库 Capability 的内部数据面。数据库内部测试可使用结果和证据引用，但当前
终端没有数据库配置或分析命令，也没有公开 SDK/HTTP 数据读取接口；不能将该内部实现描述为用户
可读取的结果服务。

## 可观测性和安全

用户活动、审计投影、模型指标和按模式使用量来自共同的耐久事实。活动不是思维链，结果引用也不
保证永久可读；其生命周期由底层项目存储决定。`.schemanaut/` 下的本地状态可能包含任务历史和
本地产物引用，应作为敏感项目数据保护。

外部计费、组织级报表、长期分析平台和公网数据服务不在当前交付范围内。

## 代码与验证

- Journal 和投影：[`packages/core-agent/src/events`](../../packages/core-agent/src/events)、[`packages/core-agent/src/session/session-projection.ts`](../../packages/core-agent/src/session/session-projection.ts)
- Artifact Store：[`packages/core-agent/src/artifacts/project-artifact-store.ts`](../../packages/core-agent/src/artifacts/project-artifact-store.ts)
- Tool 结果投影：[`packages/core-agent/src/tool-result.ts`](../../packages/core-agent/src/tool-result.ts)
- 分页读取 Tool：[`packages/core-tools/src/result-tools.ts`](../../packages/core-tools/src/result-tools.ts)
- 使用量：[`packages/core-usage/src`](../../packages/core-usage/src)
- 内部数据库结果：[`packages/database-capability/src/sql-run-store.ts`](../../packages/database-capability/src/sql-run-store.ts)
- 终端结果呈现：[`apps/terminal/src/interactive-cli.ts`](../../apps/terminal/src/interactive-cli.ts)
