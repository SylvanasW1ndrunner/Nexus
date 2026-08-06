# SchemaNaut CLI 使用指南

[English](README.md) | [返回项目首页](../../README.zh-CN.md) | [SDK 指南](../sdk/README.zh-CN.md) | [REST API 参考](../sdk/api-reference.zh-CN.md)

SchemaNaut CLI 是本地交互入口。它与 SDK、REST API 使用同一套 Runtime、Session、Schema 知识、Skills、MCP 和权限合同，不是另一套简化实现。

适合人工探索数据库、生成并执行 SQL、恢复历史 Session；程序集成和无人值守调用应使用 SDK 或 REST API。

## 1. 环境要求

- Node.js 22.13 或更高版本。持久化 Session 使用 `node:sqlite`；无需 `--experimental-sqlite` 启动参数，但 Node 22 仍将该模块标为实验性。
- PostgreSQL。v1 暂只完整支持 PostgreSQL。
- 一个支持 Tool Calling 的 OpenAI-compatible 模型 Endpoint。
- 远程模型通常需要 API Key；本地 Ollama 可以不设置。

## 2. 安装

安装当前公开 Alpha 版本：

```bash
npm install @nwlworkshop/schemanaut@alpha
```

也可以构建并安装仓库生成的本地发行包：

```bash
pnpm install
pnpm package:npm
npm install ./release/SchemaNaut-v0.1.0-alpha.1/schemanaut-v0.1.0-alpha.1.tgz
```

本文统一使用 `npx schemanaut`。它优先运行当前项目安装的版本，不要求全局安装。只有确实需要系统级命令时才使用：

```bash
npm install --global @nwlworkshop/schemanaut@alpha
schemanaut --help
```

## 3. 最快启动

### 3.1 初始化项目

```bash
npx schemanaut init ./my-data-project
```

这会创建：

```text
my-data-project/
├── .schemanaut/
│   ├── AGENT.md
│   ├── settings.json
│   ├── mcp.json
│   └── skills/
├── sql/
└── artifacts/
```

### 3.2 创建配置

在 `my-data-project/.env` 写入：

```dotenv
SCHEMANAUT_LLM_PROTOCOL=openai-chat
SCHEMANAUT_LLM_BASE_URL=https://api.siliconflow.cn/v1
SCHEMANAUT_LLM_API_KEY=替换为你的密钥
SCHEMANAUT_LLM_MODEL=替换为支持Tool-Calling的模型
SCHEMANAUT_DATABASE_URL=postgresql://user:password@127.0.0.1:5432/database

# 可选：第三方中转站使用自定义模型名时，指定其真实元数据身份
# SCHEMANAUT_LLM_CANONICAL_MODEL=openai/gpt-4o

# 可选：不设置时沿用 Endpoint/模型默认值
# SCHEMANAUT_LLM_TEMPERATURE=0.2
# SCHEMANAUT_LLM_TOP_P=0.9
# SCHEMANAUT_LLM_MAX_OUTPUT_TOKENS=4096
# SCHEMANAUT_LLM_REASONING_EFFORT=medium

# 可选：Session、检查点和偏好的 SQLite 文件
# SCHEMANAUT_STATE_DATABASE_PATH=.schemanaut/state.db

# 可选：首次建立 Schema 知识时最多索引的表数，默认 500，范围 1～1000
# SCHEMANAUT_MAX_SCHEMA_TABLES=500
```

CLI 先加载 `<project>/.env`，再读取进程环境变量；进程中已经存在的变量优先。配置解析错误只报告行号和错误类型，不回显密钥值。

`SCHEMANAUT_LLM_PROTOCOL` 支持 `openai-chat`、`openai-responses`、`anthropic`、`ollama` 和 `vllm`。相同配置也可写入 `.schemanaut/settings.json` 的单个 `llm.generation` 对象；不按 Agent/NL2SQL 等任务拆分参数。模型上下文窗口不可手工设置：运行时依次使用 Endpoint 元数据、内置 models.dev 目录，均未知时明确显示“未知”且不自动压缩。模型明确拒绝温度等参数时，CLI 会报告具体不支持的参数。

项目配置示例（API Key 应保留在 `.env`，不要写入此文件）：

```json
{
  "version": 1,
  "llm": {
    "protocol": "openai-chat",
    "baseUrl": "https://api.siliconflow.cn/v1",
    "model": "provider-model-id",
    "canonicalModel": "openai/gpt-4o",
    "generation": {
      "temperature": 0.2,
      "topP": 0.9,
      "maxOutputTokens": 4096
    }
  }
}
```

本地 Ollama 示例：

```dotenv
SCHEMANAUT_LLM_PROTOCOL=ollama
SCHEMANAUT_LLM_BASE_URL=http://127.0.0.1:11434
SCHEMANAUT_LLM_MODEL=qwen2.5-coder:14b
SCHEMANAUT_DATABASE_URL=postgresql://user:password@127.0.0.1:5432/database
```

Ollama 可省略 `SCHEMANAUT_LLM_API_KEY`。模型本身仍需正确支持 Ollama 的 Tool Calling 格式。

第三方中转站只要兼容 OpenAI API，填写它提供的 Base URL、API Key 和模型名即可：

```dotenv
SCHEMANAUT_LLM_PROTOCOL=openai-chat
SCHEMANAUT_LLM_BASE_URL=https://your-provider.example/v1
SCHEMANAUT_LLM_API_KEY=...
SCHEMANAUT_LLM_MODEL=provider-model-id
# SCHEMANAUT_LLM_CANONICAL_MODEL=openai/gpt-4o
```

### 3.3 一条命令进入 CLI

```bash
npx schemanaut chat -C ./my-data-project
```

CLI 启动时会连接模型与 PostgreSQL，并建立或刷新当前数据库的 Schema 知识目录。随后可以直接提问：

```text
schemanaut> 列出最近 7 天每天的已支付订单金额
```

## 4. 顶层命令

```text
npx schemanaut serve [--host 127.0.0.1] [--port 3721]
npx schemanaut chat [-C project]
npx schemanaut init [project]
npx schemanaut skills [-C project]
npx schemanaut sessions [-C project]
npx schemanaut --help
```

| 命令 | 用途 |
| --- | --- |
| `serve` | 启动本地 REST API 与轻量 WebUI；省略子命令时也是默认行为 |
| `chat` | 进入交互式 AI SQL CLI |
| `init` | 创建 Project 目录结构，不写入密钥 |
| `skills` | 列出该 Project 可发现的系统、用户和项目 Skills |
| `sessions` | 列出该 Project 的持久 Session |
| `-C, --project` | 指定 Project 目录 |
| `--host`, `--port` | 设置本地 API 监听地址和端口 |

## 5. 对话内命令

```text
/mode read|edit|full
/new
/resume <session-id>
/sessions
/skills
/<skill> [任务]
/compact [关注点]
/trace on|off
/model
/mcp list
/mcp start <server-id>
/mcp stop <server-id>
/exit
```

- `/mode` 切换本次对话的权限模式。
- `/new` 开始新的隔离 Session。
- `/resume` 恢复一个持久 Session；可先用 `/sessions` 找到 ID。
- `/skills` 列出可用 Skill；使用 `/<skill> [任务]` 显式激活。
- `/compact` 手动触发当前 Session 的上下文压缩；完整历史仍保留。
- `/trace on|off` 显示或隐藏面向用户的执行轨迹，默认开启；轨迹包含完整 SQL/命令、执行状态、耗时、退出码、重要错误与产物，不包含隐藏推理。TTY 中最终答复出现时会折叠本轮轨迹，按 `Ctrl+O` 可随时展开或收起。
- `/model` 显示当前协议、模型、物理上下文窗口、可输入容量和元数据来源；不会把未知模型伪装成 32K。
- `/mcp` 管理当前 Project 在 `.schemanaut/mcp.json` 中声明的 MCP Server。
- `/exit` 或 `/quit` 退出。

Agent 运行时继续输入普通文字，会把新要求追加到当前任务。`Ctrl+C` 只取消当前执行，已经建立的 Session 仍会保留。

## 6. 权限与许可

| 模式 | 无需许可即可执行 | 超出模式时 |
| --- | --- | --- |
| `read` | Schema 查看和只读 SQL | 修改数据、DDL、管理动作会请求单次许可 |
| `edit` | `read` 能力、行数据修改、Project 文件编辑 | DDL、破坏性 Schema 变更、进程执行和管理动作会请求单次许可 |
| `full` | 读、写、DDL、破坏性操作、进程和已启用的管理工具 | 不会仅因权限模式请求许可 |

出现许可请求时：

```text
y                 本次允许
n                 拒绝
输入其他普通文字   拒绝原动作，并把文字作为新的任务要求
```

权限模式是应用层合同，不会替代 PostgreSQL 自身的账号权限。

## 7. Session、结果和文件

- 每个 Project 的 Session 相互隔离，并持久化到 SQLite。
- 查询结果不会写入对话历史或用户偏好。一次交互响应最多单独返回 1,000 行；恢复 Session 时不会恢复旧的数据库行。
- Agent 可把 SQL 脚本写入 Project 的 `sql/`，把其他产物写入 `artifacts/`。
- 默认状态文件位于 SchemaNaut 的本地数据目录；设置 `SCHEMANAUT_STATE_DATABASE_PATH` 可以固定到自定义位置。

## 8. Skills 与 MCP

项目级 Skill 路径：

```text
.schemanaut/skills/<skill-name>/SKILL.md
```

项目级 MCP 配置：

```text
.schemanaut/mcp.json
```

MCP Server 默认只加载配置，不自动启动。使用 `/mcp start <server-id>` 显式启动已经审核的 Server。不要把密钥直接写入 `AGENT.md`、Skill 或 MCP 配置；应使用宿主可解析的 Secret 引用。

## 9. 同一个安装包启动 API

```bash
npx schemanaut serve --host 127.0.0.1 --port 3721
```

打开 <http://127.0.0.1:3721>，健康检查为：

```bash
curl http://127.0.0.1:3721/health
```

AI SQL 主链路：

1. `POST /v1/setup`
2. `POST /v1/schema/index`
3. `POST /v1/agent/run`，或通过 `POST /v1/agent/run/stream` 接收 SSE

完整请求与响应见 [REST API 参考](../sdk/api-reference.zh-CN.md)。

## 10. 常见问题

### 提示缺少连接配置

确认 `-C` 指向的目录中存在 `.env`，并至少设置：

```text
SCHEMANAUT_LLM_BASE_URL
SCHEMANAUT_LLM_MODEL
SCHEMANAUT_DATABASE_URL
```

远程模型通常还需要 `SCHEMANAUT_LLM_API_KEY`。

### PostgreSQL TLS

连接 URL 支持：

```text
sslmode=disable
sslmode=require
sslmode=verify-ca
sslmode=verify-full
```

不接受 `sslmode=prefer`，因为 Node 运行时无法保证其降级语义。

### 模型能对话但不能执行工具

这通常表示模型或 Endpoint 没有按 OpenAI-compatible Tool Calling 格式返回工具调用。先确认模型能力和中转站兼容性；SchemaNaut 不会通过普通文本猜测并执行工具调用。

### 端口已被占用

```bash
npx schemanaut serve --host 127.0.0.1 --port 3722
```

### 自动化调用

CLI 面向人工交互。服务程序应直接使用 [TypeScript SDK](../sdk/README.zh-CN.md)，跨语言或独立进程应使用 [REST API](../sdk/api-reference.zh-CN.md)。
