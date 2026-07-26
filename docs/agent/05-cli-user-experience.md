# CLI 与用户体验

## 1. 目的

CLI 是 SDK/API 之外的直接使用入口。顶层命令保持精简，负责项目初始化、服务运行、交互式 Agent、Session 列表和 Skill 列表；权限、Session 恢复、MCP、压缩和任务中追加要求集中在交互模式内。

## 2. 命令

```text
schemanaut init [directory]
schemanaut serve [--host 127.0.0.1] [--port 3721]
schemanaut chat [-C project]
schemanaut sessions [-C project]
schemanaut skills [-C project]
```

交互式输入支持：

- `/help`
- `/mode read|edit|full`
- `/new`
- `/resume <session-id>`
- `/sessions`
- `/skills`
- `/<skill-name> [args]`
- `/compact [关注点]`
- `/mcp list`
- `/mcp start <server-id>`
- `/mcp stop <server-id>`
- `/exit`

Agent 运行中继续输入普通文字，会追加为当前任务的新要求；许可提示中输入新要求会拒绝原操作并转向新要求。`Ctrl+C` 取消当前执行但保留 Session。MCP Server 的新增、删除和 Secret 配置使用项目 `.schemanaut/mcp.json`、SDK 或 REST API 完成。

## 3. 三层输出

### 最终用户

默认只显示当前工作、生成 SQL、重要修正、批准、结果和文件。

### SDK/API 集成者

消费 Session、语义事件、批准请求、产物引用、错误码和可选性能指标。

### 内部测试

模型调用、完整工具输入输出、检索分数、动作签名、压缩细节和评测轨迹只进入内部日志和测试报告。

三层输出使用独立合同和投影，不能把内部日志直接截断后当成用户轨迹。

## 4. 用户事件

用户事件包括：

- `goal-understood`
- `plan-updated`
- `exploring`
- `sql-prepared`
- `approval-required`
- `sql-executed`
- `correcting`
- `artifact-created`
- `completed`
- `needs-user-input`

事件文本使用用户语言，并包含真正有帮助的 SQL、对象名、影响行数、耗时或文件路径。事件不包含隐藏推理、知识 Hash、内部节点、Tool Call ID 和评测字段。

## 5. 许可交互

许可只提供“本次允许”和“拒绝”。用户可以直接输入新消息改变当前任务；不提供额外的“取消整个任务”按钮。新输入会使尚未处理的旧许可失效。

## 6. 工程与验收

- CLI：`apps/server/src/cli.ts`
- REST：`apps/server/src/server.ts`
- 用户事件：`packages/core-agent/src/user-events.ts`
- SDK：`packages/sdk/src/runtime.ts`

从最终用户角度验收命令发现、错误提示、进度、批准和结果；从工程师角度验收退出码、环境配置覆盖、跨平台路径和无 Secret 日志。结构化自动化应直接使用 SDK 或 REST API，而不是解析 CLI 文本。
