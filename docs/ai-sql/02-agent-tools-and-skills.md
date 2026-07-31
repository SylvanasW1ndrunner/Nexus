# Agent、Tools 与内置 Skills

## 1. 目的

让 Agent 像成熟编码 Agent 浏览代码一样，按需浏览数据库资源、检索知识、探索数据、执行 SQL 并根据结果继续行动，而不是在第一次模型调用前把整个 Schema 塞进 Prompt。

## 2. Agent 运行方式

Agent 使用单一自适应循环。ReAct 是每轮行动和观察的基础思路，结构化 Plan 只保存当前目标、步骤和进度；真实证据由 Runtime 从工具执行结果独立生成：

```text
理解当前目标
→ 简单任务快速执行 / 复杂任务建立计划
→ 发现并选择 Skill 与 Tool
→ 获得数据库事实或错误
→ 更新任务进度和判断
→ Runtime 验证真实执行证据
→ 继续、换路、请求补充或给出最终结果
```

自主探索来自模型对工具的选择、当前观察结果和内置 Skill 的工作路径。运行时根据重复动作和信息增量要求 Agent 在无进展时换路；最大轮数只作为熔断。

当用户明确要求最终 SQL 必须使用或连接指定配置表、字典表或其他资源时，内置 Skill 要求这些资源参与最终 SQL，而不是只被分别探查。业务语义是否真正落实由场景用例和数据库结果验收，不通过字符串包含关系替代 SQL 语义判断。

运行时控制工具结果大小、超时、取消、Checkpoint 和内部审计。Token 与金额只记录用量，不设置默认消费上限。用户看到目标、计划进度、SQL、必要结果、审批、重要修正和产物，不直接看到内部工具负载与评测轨迹。

## 3. 常驻内置工具

| 工具               | 用途                                             | 最低权限 |
| ------------------ | ------------------------------------------------ | -------- |
| `resource_list`    | 在数据库、Schema 或表范围内列出可用资源          | 读       |
| `resource_get`     | 按表、列、约束、索引、关系和业务知识读取资源事实 | 读       |
| `knowledge_search` | 精确、全文、向量和图融合检索                     | 读       |
| `sql_execute`      | 统一执行 SELECT、DML 和 DDL；权限由 SQL 动态分类 | 动态     |
| `sql_explain`      | 获取查询计划，不执行写入                         | 读       |

当前连接由运行环境提供，模型不需要在每次调用中重复猜测 `connectionId`。工具输出默认紧凑，并支持 limit、cursor、range 和截断标记。

`resource_list` 在没有 scope、但给出 kinds 时直接从整个当前知识目录返回对应类型，适合“一次列出所有 Schema”这类请求；给出 scope 时返回该资源的直接子级。平台、集群等层级名称冲突时使用 `kind:name` 形式的可读引用，内部资源 ID 仍不进入模型。

Schema 新鲜度、SQL 权限分类、审批弹窗和 DDL 后知识更新是运行时内部行为，不暴露为模型工具。

知识库的节点 ID、父子索引、关系索引、Merkle Hash、快照 ID、检索评分和命中原因只用于 Tool 内部检索、校验与审计，不属于 Tool 返回合同，也不能进入模型对话。`resource_get` 只返回数据库语义分组；`knowledge_search` 只返回命中的表、列、约束、注释和业务知识。

数据库统计计算由 SQL 下推到数据库完成。单值、小聚合和 Top-N 小结果可以进入 Agent；大型结果只返回元数据和句柄。Agent 不读取整表后在模型侧统计。

## 4. 内置通用 Skills

系统只保留四个默认 Skill：

### 4.1 `query-and-answer`

适用于查询、统计、对比、聚合和自然语言生成 SQL。优先检索知识，必要时浏览资源或探索数据，执行后根据结果回答。

### 4.2 `discover-schema-and-shape`

适用于不熟悉数据库结构、JSON、枚举、时间范围或数据粒度的任务。通过资源检索和有限查询逐步确认事实。

### 4.3 `write-and-verify`

适用于 INSERT、UPDATE、DELETE、MERGE 和 DDL。生成 SQL 后交给权限系统；执行完成后检查影响行数或新的 Schema 版本。

### 4.4 `recover-from-sql-error`

在 SQL 执行失败时激活。读取结构和错误信息、修正 SQL，并在运行时重试上限内再次执行。

每个系统 Skill 是独立目录中的标准 `SKILL.md`。初始上下文只提供名称、描述、作用域和路径；正文、引用与脚本在选中后读取。步骤和停止条件写在 Markdown 正文，不再构造专有 Skill 清单格式和运行上限字段。

Skill 引用稳定工具能力名，不能引用实现文件和内部类名。标准字段保持 Agent Skills 生态语义，产品扩展放入 `metadata.schemanaut`。确定性的安全与一致性要求必须写入代码，不能依赖 Skill 文本。

## 5. 扩展层

```text
常驻编排与高频 AI SQL 工具
→ Tool Search 动态加载的通用工具
→ 官方 SDK 接入的用户 MCP Server
→ System / User / Project / Session Skills
```

MCP 和用户 Skills 不得扩大当前数据库账号、系统权限或本次运行授权。治理与运维能力不进入首个开源版本。

## 6. Session、上下文压缩与知识引用

Session 独立保存：

- 用户和助手消息。
- 当前请求的轻量任务计划；完成后清除。
- Runtime 生成的最小执行证据引用。
- 工具调用与最小结果摘要。
- SQL、审批和执行状态。
- 上下文压缩检查点与 Token 使用量。
- 项目引用、子 Agent 和产物引用。
- 当轮知识版本的内部审计引用。

知识版本字段只保存在运行时与内部审计记录中，不转换为模型消息或用户轨迹。Session 不复制知识库内容；新一轮默认检索最新知识。

### 6.1 压缩语义

上下文压缩只解决模型物理窗口不足，不承担消费限额：

1. 模型窗口优先来自 Provider `/models` 等模型目录中的上下文与输出上限，缺失时回退到模型注册表；可用输入窗口等于物理窗口减去输出预留，不由用户填写一个“对话预算”。
2. 达到可用输入窗口 70% 时仅进入本地预警，并优先缩短较早的 Tool 摘要；持久化摘要仍保存在 Session，完整查询结果始终不进入 Session。
3. 达到模型可用输入窗口上限时，才调用模型将“上一个检查点 + 新增历史”压缩为新的累积语义检查点；未达到物理上限时不为节省费用而提前压缩。
4. 模型下一轮读取“稳定系统上下文 + 用户偏好 + 语义检查点 + 当前任务/当前 Skill + 最近完整消息”。
5. 新历史再次接近窗口时继续生成下一代累计检查点；多次压缩不删除、不覆盖原始消息。

压缩边界按完整的 Assistant Tool Call 与 Tool Result 组合切分，不能留下孤立工具结果。摘要必须保留目标、决策、约束、数据库对象名、SQL、精确结果、错误、审批、当前状态和待办；不得包含知识库 Hash、节点 ID、树索引、检查点序号或 Tool Call ID。

若一次待压缩历史仍超过模型窗口，运行时按完整工具轮次进行线性分批，并使用上一批摘要滚动处理下一批。单条极长历史消息只把有界的头尾送入压缩模型，完整原文仍在 Session。模型返回空摘要、Tool Call、超时或失败时，运行时使用按窗口限制的确定性恢复摘要；若首轮压缩后仍超过物理窗口，会逐级缩小最近原文保留量并再次压缩，直到工作视图可被模型接收，完整 Session 不受影响。

“无限会话”表示完整 Session 可持续追加，模型工作视图可反复压缩；它不表示语义摘要绝对无损。可能变化或已被省略的数据库事实必须通过 Tool 重新读取。

### 6.2 自动与手动触发

- 自动触发：达到当前模型可用输入窗口的物理上限。
- SDK：`runtime.compactAgentSession({ sessionId, focus })`。
- REST：`POST /v1/agent/sessions/:sessionId/compact`。
- 检查点：`GET /v1/agent/sessions/:sessionId/context-checkpoints`。

`focus` 用于要求本次压缩重点保留某类信息，例如“保留已执行 SQL、错误和精确金额”。手动与自动压缩使用同一套算法、存储、审计和恢复路径。

```ts
const compacted = await runtime.compactAgentSession({
  sessionId,
  focus: '重点保留已执行 SQL、数据库错误、审批决定和精确金额',
});

console.log(compacted.status);
console.log(compacted.report.finalTokenEstimate);
```

```http
POST /v1/agent/sessions/{sessionId}/compact
content-type: application/json

{"focus":"重点保留已执行 SQL、数据库错误、审批决定和精确金额"}
```

### 6.3 持久化

Session 消息按序追加到 SQLite，压缩不会重写历史消息。Session 主记录只保存元数据和当前有效检查点；历次检查点保存在独立表中，可查询、恢复和审计。用户长期偏好作为独立派生上下文加载，不插入或改写原始对话。

### 6.4 工程参考

- [OpenAI Codex](https://github.com/openai/codex/blob/main/codex-rs/core/src/compact.rs)：自动与手动压缩共用流程，压缩后替换模型工作历史并重新注入稳定初始上下文，同时记录压缩前后 Token、耗时和触发原因。
- [Claude Code](https://code.claude.com/docs/en/context-window)：先清理较旧 Tool 输出，再生成结构化摘要；完整 Transcript 留在磁盘，根级说明与 Skills 在压缩后重新加载，手动 `/compact` 可提供关注重点。
- [MiniMax](https://agent.minimax.io/docs/techblog/agent-team)：公开工程材料强调 Session 不等于模型窗口，长期任务应把事件、产物和决定保存在窗口之外，仅把当前必要状态装入模型上下文。MiniMax 没有公开可直接复刻的具体压缩算法，因此这里只采用其长会话状态原则。

本实现不是逐行复制任何产品，而是把以上公开原则落实为适合数据库 Agent 的“完整事件历史 + 累计语义检查点 + 最近原文 + 可重查数据库事实”。

## 7. 工程路径

- Agent 循环：[`packages/core-agent/src/react-agent.ts`](../../packages/core-agent/src/react-agent.ts)
- Agent 模块总设计：[`docs/agent/README.md`](../agent/README.md)
- 权限管理：[`packages/core-agent/src/permission-manager.ts`](../../packages/core-agent/src/permission-manager.ts)
- 工具注册：[`packages/core-agent/src/tool-registry.ts`](../../packages/core-agent/src/tool-registry.ts)
- 上下文窗口、自动/手动压缩：[`packages/core-agent/src/context-manager.ts`](../../packages/core-agent/src/context-manager.ts)
- Session 与检查点存储：[`packages/core-agent/src/session-store.ts`](../../packages/core-agent/src/session-store.ts)
- AI SQL 工具：[`packages/core-tools/src/ai-sql-tools.ts`](../../packages/core-tools/src/ai-sql-tools.ts)
- Tool 语义返回边界：[`packages/core-tools/src/agent-knowledge-projection.ts`](../../packages/core-tools/src/agent-knowledge-projection.ts)
- 系统 Skills：[`packages/core-skills/skills`](../../packages/core-skills/skills)
- Skill 检索与调用：[`packages/core-skills/src/skill-search.ts`](../../packages/core-skills/src/skill-search.ts)
- SDK 手动压缩入口：[`packages/sdk/src/runtime.ts`](../../packages/sdk/src/runtime.ts)
- REST 接口：[`apps/server/src/server.ts`](../../apps/server/src/server.ts)
- 长会话性能基线：[`scripts/run-context-compaction-benchmark.mjs`](../../scripts/run-context-compaction-benchmark.mjs)
- 真实模型压缩验收：[`scripts/run-context-compaction-live-test.mjs`](../../scripts/run-context-compaction-live-test.mjs)
