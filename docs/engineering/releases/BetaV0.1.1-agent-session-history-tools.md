# BetaV0.1.1 Agent 会话历史官方工具

## 版本内容

本次为 BetaV0.1.1 增加一组官方只读 Agent 工具，用于读取本地 Agent 会话历史和流式响应历史。

新增能力：

- Agent 可列出本地历史会话。
- Agent 可读取指定会话的近期消息。
- Agent 可导出会话为 Markdown 或 JSON。
- Agent 可列出某个会话下的 stream 历史。
- Agent 可读取 stream 文本、tool calls、usage 和可选 chunks。
- Agent 可列出因中断或未完成而可恢复的 stream。
- 这些工具纳入官方插件 manifest 和权限策略。

## 验证结果

通过：

- desktop 工具注册测试：8 项通过。
- desktop Agent service 回归测试：17 项通过。
- `core-tools` TypeScript 检查通过。
- `apps/desktop` TypeScript 检查通过。

## 发行风险

- 当前 session/stream 存储仍基于 JSON 原子写入，适合 beta 阶段和中小规模历史；大量历史数据后续需要迁移到 SQLite。
- 工具目前只做字符级截断，还没有做 token-aware 裁剪。
- 不包含正式前端 UI 展示；前端重建阶段需要基于这些后端接口设计交互。
