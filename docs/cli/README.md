# SchemaNaut CLI Guide

[中文](README.zh-CN.md) | [Project home](../../README.md) | [SDK Guide](../sdk/README.md) | [REST API Reference](../sdk/api-reference.md)

The SchemaNaut CLI is the local interactive surface. It uses the same Runtime, Sessions, Schema knowledge, Skills, MCP integration, and permission contracts as the SDK and REST API; it is not a separate reduced implementation.

Use it for human-guided database exploration, SQL generation and execution, and durable Session resume. Use the SDK or REST API for application integration and unattended automation.

## 1. Requirements

- Node.js 22.13 or newer. Durable Sessions use `node:sqlite`; the `--experimental-sqlite` startup flag is not required, but Node 22 still labels the module experimental.
- PostgreSQL. It is the only complete v1 connector.
- An OpenAI-compatible model endpoint with Tool Calling support.
- Remote endpoints usually require an API key; local Ollama does not.

## 2. Install

Install the current public Alpha release:

```bash
npm install @nwlworkshop/schemanaut@alpha
```

Or build and install the local release archive:

```bash
pnpm install
pnpm package:npm
npm install ./release/SchemaNaut-v0.1.0-alpha.1/schemanaut-v0.1.0-alpha.1.tgz
```

This guide uses `npx schemanaut`, which resolves the locally installed version. A global installation is optional:

```bash
npm install --global @nwlworkshop/schemanaut@alpha
schemanaut --help
```

## 3. Quickstart

### 3.1 Initialize a Project

```bash
npx schemanaut init ./my-data-project
```

It creates:

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

### 3.2 Add configuration

Create `my-data-project/.env`:

```dotenv
SCHEMANAUT_LLM_BASE_URL=https://api.siliconflow.cn/v1
SCHEMANAUT_LLM_API_KEY=replace-with-your-key
SCHEMANAUT_LLM_MODEL=replace-with-a-tool-calling-model
SCHEMANAUT_DATABASE_URL=postgresql://user:password@127.0.0.1:5432/database

# Optional SQLite file for Sessions, checkpoints, and preferences
# SCHEMANAUT_STATE_DATABASE_PATH=.schemanaut/state.db

# Optional initial Schema indexing limit; default 500, range 1 to 1000
# SCHEMANAUT_MAX_SCHEMA_TABLES=500
```

The CLI loads `<project>/.env` first and then reads the process environment. Existing process variables take precedence. Parse errors report only the line number and error category, never a secret value.

Local Ollama example:

```dotenv
SCHEMANAUT_LLM_BASE_URL=http://127.0.0.1:11434/v1
SCHEMANAUT_LLM_MODEL=qwen2.5-coder:14b
SCHEMANAUT_DATABASE_URL=postgresql://user:password@127.0.0.1:5432/database
```

`SCHEMANAUT_LLM_API_KEY` may be omitted for Ollama. The selected model must still support Ollama's Tool Calling format.

For an OpenAI-compatible relay, use its Base URL, API key, and model identifier:

```dotenv
SCHEMANAUT_LLM_BASE_URL=https://your-provider.example/v1
SCHEMANAUT_LLM_API_KEY=...
SCHEMANAUT_LLM_MODEL=provider-model-id
```

### 3.3 Start the CLI with one command

```bash
npx schemanaut chat -C ./my-data-project
```

At startup, the CLI connects to the model and PostgreSQL and builds or refreshes the current Schema knowledge catalog. Then ask a normal question:

```text
schemanaut> Show paid revenue by day for the last seven days
```

## 4. Top-level commands

```text
npx schemanaut serve [--host 127.0.0.1] [--port 3721]
npx schemanaut chat [-C project]
npx schemanaut init [project]
npx schemanaut skills [-C project]
npx schemanaut sessions [-C project]
npx schemanaut --help
```

| Command | Purpose |
| --- | --- |
| `serve` | Start the local REST API and lightweight WebUI; also the default when no subcommand is given |
| `chat` | Start the interactive AI SQL CLI |
| `init` | Create the Project structure without writing credentials |
| `skills` | List discoverable system, user, and Project Skills |
| `sessions` | List durable Sessions for the selected Project |
| `-C, --project` | Select the Project directory |
| `--host`, `--port` | Configure the local API listener |

## 5. Interactive commands

```text
/mode read|edit|full
/new
/resume <session-id>
/sessions
/skills
/<skill> [task]
/compact [focus]
/trace on|off
/mcp list
/mcp start <server-id>
/mcp stop <server-id>
/exit
```

- `/mode` changes the authority mode.
- `/new` starts a new isolated Session.
- `/resume` restores a durable Session; use `/sessions` to find its ID.
- `/skills` lists Skills; `/<skill> [task]` activates one explicitly.
- `/compact` manually compacts the current Session context while preserving full history.
- `/trace on|off` shows or hides the user-facing execution trace; it is on by default. The trace includes complete SQL/commands, execution state, duration, exit codes, important errors, and artifacts, but not hidden reasoning.
- `/mcp` manages servers declared in `.schemanaut/mcp.json`.
- `/exit` or `/quit` exits.

Ordinary input while the Agent is running steers the active task. `Ctrl+C` cancels only the current run and preserves the Session.

## 6. Permissions and approval

| Mode | Runs without approval | Outside the mode |
| --- | --- | --- |
| `read` | Schema inspection and read-only SQL | Row changes, DDL, and administrative actions request one-call approval |
| `edit` | `read`, row changes, and Project file edits | DDL, destructive Schema changes, process execution, and administrative actions request one-call approval |
| `full` | Reads, writes, DDL, destructive operations, process execution, and enabled administration tools | Nothing requests approval solely because of the mode |

At an approval prompt:

```text
y                 approve this call
n                 reject it
any other text    reject it and steer the task with the new requirement
```

The mode is an application contract, not a replacement for PostgreSQL account privileges.

## 7. Sessions, results, and files

- Sessions are isolated by Project and persisted in SQLite.
- Query rows are not written to conversation history or user preferences. An interactive response carries at most 1,000 rows separately; resumed Sessions do not restore old database rows.
- The Agent may write SQL scripts to `sql/` and other artifacts to `artifacts/`.
- Set `SCHEMANAUT_STATE_DATABASE_PATH` to choose a specific state file.

## 8. Skills and MCP

Project Skill path:

```text
.schemanaut/skills/<skill-name>/SKILL.md
```

Project MCP configuration:

```text
.schemanaut/mcp.json
```

MCP servers are configured but not started automatically. Use `/mcp start <server-id>` for a reviewed server. Do not place credentials in `AGENT.md`, Skills, or MCP configuration; use secret references resolved by the host.

## 9. Start the API from the same package

```bash
npx schemanaut serve --host 127.0.0.1 --port 3721
```

Open <http://127.0.0.1:3721>. Health check:

```bash
curl http://127.0.0.1:3721/health
```

The main AI SQL flow is:

1. `POST /v1/setup`
2. `POST /v1/schema/index`
3. `POST /v1/agent/run`, or `POST /v1/agent/run/stream` for SSE

See the [REST API Reference](../sdk/api-reference.md) for complete request and response contracts.

## 10. Troubleshooting

### Missing connection configuration

Make sure `.env` exists under the directory selected by `-C` and defines at least:

```text
SCHEMANAUT_LLM_BASE_URL
SCHEMANAUT_LLM_MODEL
SCHEMANAUT_DATABASE_URL
```

Remote endpoints usually also require `SCHEMANAUT_LLM_API_KEY`.

### PostgreSQL TLS

The URL accepts:

```text
sslmode=disable
sslmode=require
sslmode=verify-ca
sslmode=verify-full
```

`sslmode=prefer` is rejected because the Node runtime cannot guarantee its downgrade semantics.

### The model can chat but cannot call tools

The model or relay is probably not returning the OpenAI-compatible Tool Calling shape. Verify the model and relay capabilities; SchemaNaut does not infer executable tool calls from ordinary text.

### Port already in use

```bash
npx schemanaut serve --host 127.0.0.1 --port 3722
```

### Automation

The CLI is for people. Use the [TypeScript SDK](../sdk/README.md) for in-process applications and the [REST API](../sdk/api-reference.md) for cross-language or separate-process integration.
