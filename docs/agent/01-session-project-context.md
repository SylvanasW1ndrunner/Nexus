# Session、项目与上下文

## 1. 目的

让一段对话可以长期追加、恢复、压缩和转向，同时保证不同 Session 的消息、计划、结果、批准和子 Agent 不互相读取。

## 2. Session 合同

`sessionId` 是持续会话主键。一次用户输入产生内部运行记录，但不会创建第二套对话上下文。

Session 保存：

- 用户、助手和紧凑 Tool 消息。
- 当前任务计划与完成证据。
- 当前权限模式和项目引用。
- 上下文压缩检查点。
- Token 使用量和用户可见事件引用。
- 子 Agent 关系、Agent Run 元数据和产物引用。
- 当前 Session 私有的 Markdown Skill Overlay；用户视图只显示已激活目录项，不显示正文。

同一 Session 的写入串行化；不同 Session 可以并行。用户在运行或批准期间输入新消息时，旧批准失效，新消息用于补充或替换当前目标。

## 3. 项目目录

```text
project/
├─ .schemanaut/
│  ├─ AGENT.md
│  ├─ settings.json
│  ├─ settings.local.json
│  ├─ mcp.json
│  ├─ skills/<name>/SKILL.md
│  └─ agents/
├─ sql/
└─ artifacts/
```

- `.schemanaut` 保存跨 Session 的项目配置。
- `settings.local.json` 与 Secret 只保存本地引用，不提交真实凭据。
- SQL 和用户产物保存在普通可见目录。
- Session SQLite 默认保存在用户应用数据目录，通过规范项目路径生成 Project Key；不默认写入项目仓库。多个 Project 共用一个 SQLite 文件时，Session 的查询和修改仍在持久层按 Project Key 隔离。
- 打开未初始化目录仍可工作；只有显式执行 `schemanaut init` 才创建项目配置。

## 4. 上下文来源

| 来源            | 加载方式                           |
| --------------- | ---------------------------------- |
| 系统内核        | 每轮稳定加载                       |
| 项目 `AGENT.md` | 项目打开时加载，保持简短           |
| 用户长期偏好    | 从 SQLite 检索相关项，可查看和删除 |
| Session         | 当前计划、语义检查点和最近完整消息 |
| Skill           | 只在显式或隐式选中后加载正文       |
| 数据库知识      | 通过 RAG Tool 按需检索             |
| 权限            | 由运行时判断，不作为 Prompt 规则   |

数据库事实、查询行和知识索引不复制进 Session。SQL Tool 只持久化无行值摘要；可能变化的事实在需要时重新查询。

## 5. 压缩与恢复

- 接近模型物理窗口时先缩短旧 Tool 输出，再生成累积语义检查点。
- 计划、未完成事项、用户决定、精确 SQL、必要结果和错误必须保留。
- 原始消息按序保存在 SQLite，压缩只改变模型工作视图。
- 支持手动 `/compact [focus]`。
- 项目重新打开时，通过项目路径列出最近 Session；指定 `sessionId` 只能恢复同一 Project 的 Session。旧数据若已保存 `session.project` 会在迁移时回填归属；没有 Project 的更早数据不会被任一 Project Runtime 当作全局 Session。

## 6. 工程与验收

工程入口：

- Session 类型：`packages/core-agent/src/types.ts`
- SQLite：`packages/core-agent/src/session-store.ts`
- 项目上下文：`packages/core-agent/src/project-context.ts`
- 压缩：`packages/core-agent/src/context-manager.ts`

验收：

- 不同 Session 的消息、计划、结果和 Session Skill 互不可见；并发与恢复后仍保持隔离。
- 共用同一 SQLite 文件的不同 Project 无法通过列表、读取、删除、归档、压缩、检查点、转向、Skill 查询或恢复路径访问彼此的 Session。
- 同一 Session 并发写入不会交叉或丢失。
- 项目配置可跨 Session 生效，Session 私有数据不进入项目目录。
- 10,000 条历史消息能够恢复和构建有界模型工作视图。
