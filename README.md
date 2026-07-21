# DBAgent

DBAgent 是一个本地优先的 AI 数据库运行时：连接 PostgreSQL，检索相关 Schema，让 OpenAI-compatible 模型把自然语言转换为 SQL，经过本地安全审计后，再由用户确认是否执行。

当前对外 MVP 优先提供 CLI、REST API 和极简 WebUI，不要求用户安装完整数据库 IDE；仓库内同时保留 TypeScript SDK，待接口稳定后再独立发布。

```text
自然语言问题
  → 检索相关 Schema
  → 模型生成 SQL、解释和假设
  → 本地只读安全审计
  → 用户确认
  → PostgreSQL 只读执行
```

## 当前能力

| 项目         | 当前支持                                    |
| ------------ | ------------------------------------------- |
| 数据库       | PostgreSQL                                  |
| 模型协议     | OpenAI-compatible `/chat/completions`       |
| 使用入口     | CLI、REST API、WebUI、仓库内 TypeScript SDK |
| SQL 范围     | 单条只读 `SELECT`、只读 `WITH`、`VALUES`    |
| 执行方式     | 生成与执行分离，必须显式确认                |
| 默认结果上限 | 200 行，硬上限 1000 行                      |
| 凭据存储     | 仅当前进程内存，不写入浏览器存储或配置文件  |

当前不支持 MySQL、写 SQL、DDL、多语句、自动执行、账号云同步和生产级多租户部署。

## 快速开始

### 1. 准备环境

试用者需要：

- Node.js 20.11 或更高版本，官方安装包自带 npm/npx。
- 一个 PostgreSQL 数据库，建议创建专用只读账号。
- 一个 OpenAI-compatible 模型的 Base URL、API Key 和模型名。

### 2. 启动 DBAgent

正式 npm 包名为 `@nwlworkshop/dbagent`。发布到 npm registry 后可直接运行：

```bash
npx --yes @nwlworkshop/dbagent
```

使用本地下载的 MVP tarball。团队上传 Release 后，应从本仓库的 [GitHub Releases](https://github.com/SylvanasW1ndrunner/Nexus/releases) 同时下载 `.tgz` 和 `SHA256SUMS.txt`：

```powershell
npx --yes .\DBAgent-Headless-MVP-v0.1.0.tgz
```

Windows 下可以核对下载文件：

```powershell
Get-FileHash .\DBAgent-Headless-MVP-v0.1.0.tgz -Algorithm SHA256
Get-Content .\SHA256SUMS.txt
```

两处 SHA-256 必须一致。

启动成功后会显示：

```text
DBAgent MVP 已启动：http://127.0.0.1:3721
```

端口被占用时可以指定其他端口：

```powershell
npx --yes --package .\DBAgent-Headless-MVP-v0.1.0.tgz dbagent --port 3722
```

服务只允许监听 `127.0.0.1`、`localhost` 或 `::1`，不会直接暴露到局域网。修改端口后，WebUI 地址和后续 REST 示例中的端口也要同步修改。

### 3. 在 WebUI 中配置

打开 <http://127.0.0.1:3721>，依次填写：

| 配置     | 示例                            | 说明                                            |
| -------- | ------------------------------- | ----------------------------------------------- |
| Base URL | `https://api.siliconflow.cn/v1` | 填 API 前缀；DBAgent 会追加 `/chat/completions` |
| API Key  | `sk-...`                        | 只保存在当前 Server 进程内存                    |
| 模型名   | `deepseek-ai/DeepSeek-V3`       | 必须与模型服务中的 ID 完全一致                  |
| Host     | `127.0.0.1`                     | PostgreSQL 地址                                 |
| Port     | `5432`                          | PostgreSQL 端口                                 |
| Database | `dbagent_demo`                  | 数据库名                                        |
| Username | `dbagent_readonly`              | 建议使用专用只读用户                            |
| Password | —                               | 只保存在当前 Server 进程内存                    |
| SSL      | 按数据库要求选择                | 云数据库通常需要开启                            |

表中的 `dbagent_demo` 只是本仓库测试 fixture 的数据库名。连接自己的数据库时，请替换数据库名、账号和自然语言问题；当前 SSL 配置只有布尔开关，暂不支持自定义 CA 或客户端证书。

操作顺序：

1. 点击“测试并连接”。
2. 点击“索引 Schema”。
3. 输入自然语言问题并点击“生成 SQL”。
4. 检查 SQL、解释、假设、Schema 证据和安全结果。
5. 只有状态安全时，才会显示“执行只读 SQL”按钮。

进程退出后，模型密钥、数据库密码、Schema 索引和运行记录都会清空。

## 使用 REST API

默认地址为 `http://127.0.0.1:3721`。下面的 Node.js 示例覆盖配置、索引、生成和执行完整流程。

先设置环境变量，不要把真实密钥提交到 Git：

```powershell
$env:DBAGENT_SERVER_URL = "http://127.0.0.1:3721"
$env:DBAGENT_LLM_BASE_URL = "https://api.siliconflow.cn/v1"
$env:DBAGENT_LLM_API_KEY = "替换为模型密钥"
$env:DBAGENT_LLM_MODEL = "deepseek-ai/DeepSeek-V3"
$env:DBAGENT_DB_HOST = "127.0.0.1"
$env:DBAGENT_DB_PORT = "5432"
$env:DBAGENT_DB_NAME = "dbagent_demo"
$env:DBAGENT_DB_USER = "dbagent_readonly"
$env:DBAGENT_DB_PASSWORD = "替换为数据库密码"
$env:DBAGENT_DB_SSL = "false"
```

将以下内容保存为 `try-dbagent.mjs`：

```js
import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';

const server = process.env.DBAGENT_SERVER_URL ?? 'http://127.0.0.1:3721';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`缺少环境变量：${name}`);
  return value;
}

async function post(path, body = {}) {
  const response = await fetch(`${server}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(
      `${payload.error?.code ?? response.status}: ${payload.error?.message ?? '请求失败'}`,
    );
  }
  return payload;
}

const health = await fetch(`${server}/health`).then((response) => response.json());
console.log('health:', health);

await post('/v1/setup', {
  llm: {
    baseUrl: required('DBAGENT_LLM_BASE_URL'),
    apiKey: required('DBAGENT_LLM_API_KEY'),
    model: required('DBAGENT_LLM_MODEL'),
  },
  database: {
    name: '我的只读数据库', // 仅用于显示，不是 PostgreSQL database 名
    host: required('DBAGENT_DB_HOST'),
    port: Number(required('DBAGENT_DB_PORT')),
    database: required('DBAGENT_DB_NAME'),
    username: required('DBAGENT_DB_USER'),
    password: required('DBAGENT_DB_PASSWORD'),
    ssl: required('DBAGENT_DB_SSL').toLowerCase() === 'true',
  },
});

const schema = await post('/v1/schema/index', { maxTables: 200 });
console.log('schema:', schema);

const generated = await post('/v1/query/generate', {
  question: '每个城市的订单总金额是多少？',
});
console.log('sql:', generated.sql);
console.log('explanation:', generated.explanation);
console.log('safety:', generated.safety);

if (generated.status === 'awaiting_execution') {
  const prompt = createInterface({ input, output });
  const answer = await prompt.question('确认执行上面的只读 SQL？输入 y 继续：');
  prompt.close();

  if (answer.trim().toLowerCase() === 'y') {
    const completed = await post('/v1/query/execute', {
      runId: generated.runId,
      limit: 200,
    });
    console.table(completed.execution.rows);
  } else {
    console.log('已取消，SQL 未执行。');
  }
} else {
  console.error('SQL 已被安全策略阻止，未执行。');
}
```

保持 DBAgent Server 运行，并在刚才设置环境变量的同一个 PowerShell 窗口执行：

```bash
node try-dbagent.mjs
```

### REST 接口

| 方法   | 路径                 | 用途                                        |
| ------ | -------------------- | ------------------------------------------- |
| `GET`  | `/health`            | Server 健康检查                             |
| `GET`  | `/v1/capabilities`   | 数据库、模型协议和安全能力                  |
| `GET`  | `/v1/status`         | 当前配置、连接和 Schema 状态，不返回 Secret |
| `POST` | `/v1/setup`          | 配置模型并连接 PostgreSQL                   |
| `POST` | `/v1/schema/index`   | 抽取并索引当前数据库 Schema                 |
| `GET`  | `/v1/schema/status`  | 查询 Schema 索引状态                        |
| `POST` | `/v1/query/generate` | 根据自然语言生成并审计 SQL，不自动执行      |
| `POST` | `/v1/query/execute`  | 根据 `runId` 执行已通过审计的 SQL           |
| `GET`  | `/v1/runs/{runId}`   | 查询一次生成/执行记录                       |

接口约束：

- `/v1/schema/index` 是同步请求；`maxTables` 默认 200、最大 1000，返回值中的 `truncated` 表示是否发生截断。
- 生成状态可能是 `awaiting_execution` 或 `blocked`；只有前者可执行。显式调用 `/v1/query/execute` 即表示调用方确认执行。
- `runId` 只在当前 Server 进程内有效，重启后失效；同一条记录完成、失败或被阻止后不能再次执行。
- API 当前没有登录或 Token 鉴权，安全边界依赖回环监听；不要在不可信的本机多用户环境中运行。

错误响应格式统一为：

```json
{
  "error": {
    "code": "SCHEMA_NOT_INDEXED",
    "message": "请先索引数据库 Schema。",
    "retryable": true
  }
}
```

## 仓库内 TypeScript SDK 接口示例

> 当前 `@nwlworkshop/dbagent` npm 包是 CLI/WebUI/REST 分发包，尚未导出 SDK。下面的 `@dbagent/sdk` 和 `@dbagent/core-llm` 是本仓库 workspace 包，代码用于说明嵌入接口，不能直接从已下载的 tgz 导入。

```ts
import { OpenAICompatibleProvider } from '@dbagent/core-llm';
import { DatabaseAgentRuntime } from '@dbagent/sdk';

const provider = new OpenAICompatibleProvider({
  id: 'my-provider',
  name: 'My OpenAI-compatible Provider',
  baseUrl: process.env.DBAGENT_LLM_BASE_URL!,
  apiKey: process.env.DBAGENT_LLM_API_KEY!,
});

const runtime = new DatabaseAgentRuntime({
  provider,
  model: process.env.DBAGENT_LLM_MODEL!,
  defaultRowLimit: 200,
});

try {
  await runtime.connect({
    name: 'demo',
    host: process.env.DBAGENT_DB_HOST!,
    port: 5432,
    database: process.env.DBAGENT_DB_NAME!,
    username: process.env.DBAGENT_DB_USER!,
    password: process.env.DBAGENT_DB_PASSWORD,
    ssl: false,
  });

  await runtime.indexSchema({ maxTables: 200 });

  const generated = await runtime.generate({
    question: '最近 7 天每天的订单金额是多少？',
  });

  console.log(generated.sql);
  console.log(generated.explanation);
  console.log(generated.evidence);

  if (generated.status === 'awaiting_execution') {
    const completed = await runtime.executeGenerated(generated.runId, { limit: 200 });
    console.table(completed.execution.rows);
  }
} finally {
  await runtime.disconnect();
}
```

## 安全边界

- Server 强制只监听本机回环地址。
- 数据库连接强制进入只读模式，但这不能替代数据库权限；请继续使用专用只读账号。
- 模型输出始终视为不可信输入，执行前会再次进行本地 SQL 审计。
- `INSERT`、`UPDATE`、`DELETE`、DDL、事务控制、会话设置、多语句和已知副作用函数会被阻止。
- 执行接口只接受 Server 保存的 `runId`，不接受任意 SQL 文本。
- 用户问题和检索到的 Schema 上下文（可能包含表、字段、注释和关系）会发送到所配置的模型服务；查询结果不会发送给模型。使用前应确认模型提供商的数据留存、训练和地域合规政策。
- API Key 和数据库密码只保存在当前进程内存，日志、状态接口和运行记录不会返回它们；模型 API Key 仍会作为 `Authorization: Bearer` 认证信息发送给模型服务。
- 本地审计会阻止已知副作用语句和函数，但无法证明所有自定义函数或扩展都无副作用；数据库侧最小权限是最终安全边界。
- REST API 没有应用层认证；回环监听能阻止远程直连，但不能防止同一台机器上的其他用户或进程访问。
- 当前版本用于 MVP 试用，不建议直接部署到生产环境。

## 从源码开发

### 环境要求

- Node.js 20.11+
- pnpm 9+
- 真实 PostgreSQL 集成测试需要本机 PostgreSQL、Docker fixture 或显式测试配置

```bash
pnpm install
pnpm dev:mvp
```

打开 <http://127.0.0.1:3721>。

常用命令：

```bash
pnpm build:mvp
pnpm test:mvp
pnpm test:postgres
pnpm package:mvp:npm
pnpm typecheck
pnpm lint
pnpm test
```

`pnpm package:mvp:npm` 会在 `release/HeadlessMVP-v<version>/` 生成标准 npm tarball 和 `SHA256SUMS.txt`。发布包只包含单文件 Node bundle、`package.json`、README 和第三方许可证，不包含源码、测试、`.env`、数据库服务器或模型服务。

### 本地 PostgreSQL fixture

```bash
pnpm db:up
pnpm test:postgres
pnpm db:down
```

fixture 默认连接参数：

| 配置     | 值             |
| -------- | -------------- |
| Host     | `127.0.0.1`    |
| Port     | `5432`         |
| Database | `dbagent_demo` |
| Username | `postgres`     |
| Password | `postgres`     |

这些参数只用于本地测试，不应复制到生产环境。

## 仓库结构

```text
apps/server       REST API、CLI 和极简 WebUI
packages/sdk      自然语言转 SQL Runtime 与状态机
packages/core-db  PostgreSQL 驱动和 SQL 安全审计
packages/core-llm OpenAI-compatible Provider
packages/core-rag Schema 抽取、索引、检索和上下文构建
apps/desktop      保留的 Electron 数据库 IDE
docs/product      中文产品与架构文档
docs/engineering  工程、测试、打包和发布文档
```

MVP 的完整范围和验收标准见 [`docs/product/11-headless-mvp.md`](docs/product/11-headless-mvp.md)。

## 常见问题

### Base URL 应该填什么？

填写兼容 OpenAI API 的前缀，不要包含 `/chat/completions`。例如填写 `https://api.siliconflow.cn/v1`，DBAgent 会请求 `https://api.siliconflow.cn/v1/chat/completions`。

### 为什么连接成功后还不能提问？

必须先点击“索引 Schema”。模型生成 SQL 前需要知道真实的表、字段、注释和关系。

### 为什么 SQL 没有执行按钮？

该 SQL 被本地安全策略标记为 `blocked`，或者不是单条只读查询。查看页面中的“安全原因”获取具体信息。

### 为什么重启后需要重新配置？

MVP 故意不持久化 Secret、Schema 索引和运行记录，以缩小安全面。后续版本会在明确的本地加密存储边界内增加可选持久化。

### 如何停止服务？

在启动 DBAgent 的终端按 `Ctrl+C`。
