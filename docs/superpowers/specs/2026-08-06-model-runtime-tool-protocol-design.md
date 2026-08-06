# 模型运行时、Tool Calling 与 CLI 轨迹重构设计

## 1. 目标

本次改造解决四类已经在真实 CLI 使用中出现的问题：

- 模型上下文未知时被伪装成 32K，导致错误压缩、错误预算和错误展示。
- Assistant Tool Call 被序列化成 `<tool_calls>` 文本，破坏 Provider 原生协议并诱发重复执行。
- 模型参数分散且部分调用硬编码温度，用户无法用一套配置控制当前对话。
- CLI 只显示笼统阶段，最终回答前又删除轨迹，用户无法判断 Agent 做了什么、为何耗时。

改造不得改变数据库结果管线：数据库继续承担过滤、聚合与计算；Agent 只接收有界投影；SDK/API/CLI 的查询结果继续作为独立载荷返回，Session 不保存巨量结果。

## 2. 设计原则

1. Tool Call 是结构化协议对象，不是文本提示词。
2. Provider Adapter 负责协议差异，Agent 只消费统一合同。
3. 模型上下文未知就是 `unknown`，不使用 32K 等虚构默认值。
4. Endpoint 原生元数据优先；本地快照只做离线基线；用户别名只解决模型改名。
5. 用户只有一套会话生成参数，不按 `agent`、`nl2sql`、`contextCompaction` 拆桶。
6. 用户可见的是计划、动作、SQL/命令、结果与恢复，不展示隐藏推理或内部索引。
7. 同一 Tool Call ID 在一次 Run 内最多执行一次；相同参数的新 ID 仍可合法再次读取。
8. 最大迭代数只是失控保护，不作为正常任务的阶段边界。

## 3. 模型元数据

### 3.1 数据源与优先级

项目随 npm 包携带 `model_prices_and_context_window.json`。该文件由 `models.dev/api.json` 生成，只保留运行时需要的字段：

- Provider ID、模型 ID、显示名与 family。
- `limit.context`、`limit.input`、`limit.output`。
- Tool Calling、Reasoning、Structured Output、Temperature 支持状态。
- 输入/输出价格与更新时间。

解析优先级从高到低为：

1. 当前 Endpoint 的模型元数据接口。
2. 用户配置的 `canonicalModel` 指向的 models.dev Provider/Model。
3. 当前 Provider ID 与模型 ID 在本地快照中的精确项。
4. 唯一可判定的基础模型项。
5. `unknown`。

Endpoint 只覆盖自己实际提供的字段；未提供的字段继续保留快照值。运行时不联网刷新快照，仓库脚本负责显式更新、校验和记录来源。

### 3.2 上下文合同

模型限制拆分为：

```ts
export type LlmModelLimits = {
  contextTokens: number | null;
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  requestsPerMinute?: number;
  tokensPerMinute?: number;
  maxConcurrency?: number;
};
```

`null` 表示未知。可用 Prompt 容量取已知 `maxInputTokens` 与 `contextTokens - reservedOutputTokens` 的较小值。未知窗口时不自动压缩；手动 `/compact` 仍按内部有界批次工作，但不得把批次大小展示成模型物理窗口。

### 3.3 Canonical Model

第三方中转站可以把 `deepseek/deepseek-chat` 改名为 `company-ds`。用户可配置：

```json
{
  "llm": {
    "canonicalModel": "deepseek/deepseek-chat"
  }
}
```

该配置只参与元数据匹配，不改发往 Endpoint 的真实模型 ID。

## 4. 会话生成参数

统一配置：

```ts
export type LlmGenerationConfig = {
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
  seed?: number;
  stop?: string[];
  reasoningEffort?: 'low' | 'medium' | 'high';
};
```

- 未配置的字段不进入请求，使用 Provider 默认值。
- Runtime 默认配置可被单次 SDK/API/Agent Run 覆盖。
- 上下文窗口不属于用户生成参数，配置时必须给出明确错误。
- 元数据明确标记参数不支持时，在网络请求前返回参数名、模型和来源。
- 元数据未知时照常发送；上游 400 被归一为结构化参数错误，不能静默删除参数重试。
- NL2SQL、Agent 与上下文压缩共享同一套用户配置；内部只允许收紧输出上限，不允许偷偷改温度。

## 5. 统一消息与工具合同

### 5.1 Canonical Message

```ts
export type LlmMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: LlmToolCall[];
  toolResult?: { isError?: boolean };
};
```

不变量：

- `toolCalls` 只属于 Assistant 消息。
- Tool 消息必须包含 `toolCallId` 和 `name`。
- Tool Call 的 ID、名称和 JSON 参数原样保留。
- Context 压缩与持久化可以摘要 Tool 结果，但不得把 Tool Call 改写成 XML/DSML。

### 5.2 Provider 映射

| Provider 协议 | Assistant Tool Call | Tool Result |
| --- | --- | --- |
| OpenAI Chat Completions / vLLM | `assistant.tool_calls[]` | `role=tool` + `tool_call_id` |
| OpenAI Responses | `function_call` + `call_id` | `function_call_output` + `call_id` |
| Anthropic Messages | `assistant.content[].tool_use` | 紧随其后的 `user.content[].tool_result` |
| Ollama `/api/chat` | `assistant.tool_calls[]` | `role=tool` + `tool_name` |

OpenAI-compatible 中转站默认使用 Chat Completions；用户可以显式选择 Responses。Ollama 原生与 `/v1` 兼容模式分开配置。vLLM 使用 OpenAI-compatible Adapter，服务器必须正确启用 tool parser 与 chat template。

### 5.3 协议失配

请求带 Tools 时，如果 Provider 只返回 `<tool_calls>`、DSML 等文本而没有结构化调用，Adapter 返回 `TOOL_PROTOCOL_MISMATCH`。文本永远不执行，Agent 不再追加提示词盲目重试；错误中说明当前协议、模型和建议检查项。

### 5.4 执行幂等

Run 内维护 `toolCallId -> {signature, result}`：

- 第一次调用正常执行并保存结果。
- 相同 ID 与相同签名再次出现时，向模型重放已保存结果，不执行 Handler。
- 相同 ID 但名称或参数不同是协议错误。
- 相同名称/参数但新 ID 可以执行；无进展检测只负责提示模型换路径，不充当硬拦截。

## 6. Agent 收敛与上下文

- 默认最大迭代提高到 100，只作为应急上限。
- 语义计划、下一步动作与最终答复由模型产生。
- Runtime 只管理结构状态、许可、执行证据、幂等、协议状态与确定性完成门禁。
- 有交付证据时进入 Finalize；没有证据时不能声称完成。
- 达到应急上限时保存 Checkpoint、真实证据和可恢复状态，返回可操作原因。
- 自动压缩只在已知模型物理窗口达到阈值时触发；手动压缩始终可用。
- Tool 结果、Tool Call 和 Tool Result 必须作为一个原子对话组保留或压缩。

## 7. CLI 用户轨迹

CLI 默认显示：

- 目标理解和计划变化。
- 正在读取的知识、Schema、文件、网页或 MCP 能力。
- 即将执行的完整 SQL/命令及许可请求。
- 执行耗时、行数、影响行数、错误与恢复动作。
- 产物路径、最终轮次、工具执行次数、Token 与总耗时。

不显示内部 Hash、Node ID、Tool Call ID、检索分数或隐藏 Chain-of-Thought。

TTY 中运行时轨迹展开；最终答复前折叠为一行摘要；`Ctrl+O` 可展开/收起本轮完整轨迹。`/trace on|off` 控制是否采集和展示。非 TTY 日志不删除轨迹。

## 8. 数据管线不变量

- SQL 过滤、Join、聚合、窗口函数和大规模计算仍由数据库执行。
- Agent 默认最多接收 100 行且受字节上限约束的模型投影。
- SDK/API/CLI 独立结果载荷最多返回 1,000 行并携带分页/导出信息。
- Session 只保存有界摘要和 Result Handle，不保存完整查询结果，也不写入用户偏好。
- 模型元数据、协议和 CLI 改造不得改变三级数据库权限与 AST 判定。

## 9. 验收指标

- 任意正常模型请求与最终回答中不出现运行时生成的 `<tool_calls>`。
- 同一 Tool Call ID 的 Handler 执行次数为 1。
- 协议失配在第一次响应后终止，不产生盲目 Tool 重试。
- 未知模型上下文显示 `unknown`，不再出现默认 32K。
- 已知模型按 Endpoint > canonical snapshot > provider snapshot 的顺序生效。
- 简单 Schema 查询目标：不超过 2 次模型调用、1 次相关 Schema/知识工具。
- 真实测试记录每场景的模型、元数据来源、上下文、轮次、模型调用、工具调用、重复 ID、Token、首响应时间和总耗时。
- OpenAI Chat、Responses、Anthropic、Ollama 与 vLLM 兼容合同均有确定性测试；SiliconFlow 至少选择三类真实模型执行端到端测试。
