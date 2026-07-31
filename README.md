<div align="center">

# SchemaNaut

### Ask in natural language. Get SQL. Keep control.

**An embeddable, open-source AI SQL Agent for PostgreSQL.**

[![Status: Alpha](https://img.shields.io/badge/status-alpha-f59e0b)](CHANGELOG.md)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-3b82f6)](LICENSE)
[![Node.js 22.13+](https://img.shields.io/badge/node-%3E%3D22.13-339933?logo=nodedotjs&logoColor=white)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?logo=typescript&logoColor=white)](packages/sdk/src/index.ts)

[中文](README.zh-CN.md) · [CLI Guide](docs/cli/README.md) · [SDK Guide](docs/sdk/README.md) · [API Reference](docs/sdk/api-reference.md) · [Contributing](CONTRIBUTING.md)

</div>

SchemaNaut turns a natural-language request into a database task: it retrieves the relevant Schema and business knowledge, plans the work, generates SQL, asks for permission when needed, executes through the database, and corrects itself from real errors.

It is built for embedding and automation. The primary surfaces are a TypeScript SDK and local REST API, with an interactive CLI and deliberately small WebUI. It is not a database IDE.

> SchemaNaut `0.1.x` is alpha software. PostgreSQL is the first complete connector. Do not use it as a production security boundary without your own database permissions, secret management, and review process.

## What v1 includes

| Capability             | Behavior                                                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Knowledge-aware AI SQL | Hierarchical Schema catalog, Project/Skill business guidance, hybrid retrieval, and automatic refresh after successful Agent DDL                  |
| Adaptive Agent loop    | One plan-guided ReAct loop that explores, executes, observes, repairs, and verifies completion; there is no user-facing “strategy mode”           |
| Durable Sessions       | SQLite-backed isolated conversations, plans, artifacts, token usage, checkpoints, context compaction, and user-scoped long-term preferences       |
| Project context        | A selected project root with `.schemanaut/AGENT.md`, project Skills, MCP configuration, SQL scripts, and artifacts                                |
| Explicit authority     | `read`, `edit`, and `full` modes, plus a one-call approval callback for actions outside the current mode                                          |
| Progressive Skills     | Standard Markdown `SKILL.md` bundles at system, user, project, and Session scope; only the catalog is shown until a Skill is activated            |
| Standard MCP client    | Official MCP SDK with stdio, Streamable HTTP, and SSE compatibility, dynamic tool discovery, lifecycle, cancellation, and secret references       |
| Project tools          | Project-scoped files, optional host web tools, bounded shell execution in `full` mode, and same-capability child Agents with independent context  |
| Separated query results | The database performs aggregation and filtering; SDK/API callers receive at most 1,000 rows separately while the model sees at most 100 transient rows within 64 KiB |
| Integration surfaces   | TypeScript SDK, local REST API, interactive CLI, and lightweight local WebUI                                                                      |

AI database governance and operations are a later product stage. v1 does **not** ship a governance/operations Agent or claim autonomous DBA remediation.

## How it works

```mermaid
flowchart LR
    User["App / CLI / REST"] --> Session["Session + Project"]
    Session --> Agent["Plan-guided ReAct Agent"]
    Agent --> Discover["Skills + dynamic Tool discovery"]
    Discover --> Knowledge["Schema knowledge"]
    Discover --> Extensions["Built-in Tools + MCP"]
    Agent --> Policy["read / edit / full"]
    Policy --> PostgreSQL["PostgreSQL executes SQL"]
    PostgreSQL --> Results["Bounded query result (max 1,000 rows)"]
    Results --> Preview["Transient model projection (max 100 rows / 64 KiB)"]
    Preview --> Agent
    Results --> Output["Separate result payload"]
    Agent --> Output["Verified answer + SQL + useful events + artifacts"]
```

Internal knowledge hashes, node IDs, ranking scores, and evaluation traces do not enter the normal model or user output.

## Install

Requirements:

- Node.js 22.13 or newer (durable Sessions use `node:sqlite`; the `--experimental-sqlite` startup flag is not required, but Node 22 still labels the module experimental)
- PostgreSQL
- An OpenAI-compatible model endpoint or Anthropic Messages endpoint
- Tool calling for Agent workflows

The public npm package has not been published yet. Build the installable archive from this repository:

```bash
pnpm install
pnpm package:npm
npm install ./release/SchemaNaut-v0.1.0/schemanaut-v0.1.0.tgz
```

`pnpm test:npm-package:functional` verifies `SHA256SUMS.txt`, release-version
metadata, secret scanning, an isolated local install, SDK/REST/CLI behavior, and
TypeScript declarations before the archive is accepted.

The planned package name is `@nwlworkshop/schemanaut`.
Commands below use `npx schemanaut`, which resolves the CLI from this local installation.
Use `npm install --global ./release/SchemaNaut-v0.1.0/schemanaut-v0.1.0.tgz` only when you explicitly want a global command.

## Fastest path: interactive CLI

Initialize a project:

```bash
npx schemanaut init ./my-data-project
```

Set the model and PostgreSQL connection, then start chat:

```bash
export SCHEMANAUT_LLM_BASE_URL="https://your-openai-compatible-endpoint/v1"
export SCHEMANAUT_LLM_API_KEY="..."
export SCHEMANAUT_LLM_MODEL="your-model"
export SCHEMANAUT_DATABASE_URL="postgresql://user:password@127.0.0.1:5432/app"

npx schemanaut chat -C ./my-data-project
```

For local Ollama, use an endpoint such as `http://127.0.0.1:11434/v1`; the API key may be omitted.

Useful interactive commands:

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

While the Agent is running, ordinary text is added as a new requirement to the active task. `Ctrl+C` cancels the current run while preserving the Session.

## Embed the SDK

```ts
import { DatabaseAgentRuntime, createProviderFromPreset } from '@nwlworkshop/schemanaut';

const apiKey = process.env.LLM_API_KEY;
if (!apiKey) throw new Error('LLM_API_KEY is required');

const runtime = new DatabaseAgentRuntime({
  tenantId: 'team-a',
  projectDirectory: process.cwd(),
  provider: createProviderFromPreset('siliconflow', {
    apiKey,
  }),
  model: process.env.LLM_MODEL!,
  approvalProvider: async ({ mode, tool, toolCall }) => {
    console.log(`Approval requested: ${mode} -> ${tool.name}`, toolCall.arguments);
    return false;
  },
});

try {
  await runtime.connect({
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 5432),
    database: process.env.DB_NAME!,
    username: process.env.DB_USER!,
    password: process.env.DB_PASSWORD,
    readOnly: true,
  });

  await runtime.indexSchema();

  const run = await runtime.runAgent({
    userId: 'user-1',
    message: 'Show paid revenue by day for the last seven days.',
    mode: 'read',
    onEvent: (event) => {
      console.log(event.type, event.message);
    },
  });

  console.log(run.result.finalText);
  console.table(run.queryResults[0]?.rows ?? []);
  console.log(run.result.session.id);

  const continued = await runtime.runAgent({
    sessionId: run.result.session.id,
    message: 'Compare it with the previous seven days.',
    mode: 'read',
  });

  console.log(continued.result.finalText);
} finally {
  await runtime.close();
}
```

Save `run.result.session.id` if the conversation must continue after the process restarts.

`runAgent()` is the trusted SDK integration surface and returns the complete run, including tool execution records. Application-facing Session views are available through `listAgentSessions()` and `getAgentSession()`; they omit tool messages, internal retrieval identifiers, Skill instructions, and evaluation details.

Query rows are returned through `run.queryResults`, not written into the conversation, Session history, or user preferences. See the [SDK Guide](docs/sdk/README.md) for Projects, Skills, MCP, bounded query results, cancellation, direct model calls, and the lower-level database runtime.

## Permission modes

| Mode   | Runs without approval                                          | Requests one-call approval                                         |
| ------ | -------------------------------------------------------------- | ------------------------------------------------------------------ |
| `read` | Schema inspection and read-only SQL                            | Row changes, DDL, destructive, or administrative actions           |
| `edit` | Everything in `read`, row changes, and Project file edits      | DDL, destructive Schema changes, shell, and administrative actions |
| `full` | Read, edits, DDL, destructive, shell, and administrative tools | Nothing solely because of the mode                                 |

An approved request applies to that tool call only. A rejection becomes an Agent observation, so it can choose a safer path or explain what it cannot complete.

If `approvalProvider` is omitted, the Runtime uses its built-in approval broker. A UI or API host can call `listAgentApprovals()` and `resolveAgentApproval()` while the Agent waits, for up to five minutes by default. Supplying a custom callback replaces this broker-backed flow.

These modes are application policy—not a replacement for PostgreSQL privileges. Always use an appropriately restricted database account.

## Projects, Skills, and MCP

`schemanaut init` creates:

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

- Put recurring project guidance in `.schemanaut/AGENT.md`; never put credentials there.
- Add project Skills as `.schemanaut/skills/<name>/SKILL.md`.
- Add MCP servers to `.schemanaut/mcp.json`; sensitive environment variables and headers must use secret references resolved by the host application.
- A Session is durable conversation state. A Project is reusable directory context. They are related but not interchangeable.

## Local REST API and WebUI

Start the loopback-only service:

```bash
npx schemanaut serve --host 127.0.0.1 --port 3721
```

Open <http://127.0.0.1:3721>. The main AI SQL flow is:

1. `POST /v1/setup`
2. `POST /v1/schema/index`
3. `POST /v1/agent/run` for one JSON result, or `POST /v1/agent/run/stream` for semantic SSE events

Both Agent endpoints return a de-internalized `AiSqlAgentRunView` intended for users rather than the SDK's complete integration record. Database rows live in its separate, ephemeral `queryResults` payload and are never embedded in Session messages. Public management endpoints cover Session list/get/delete/steer, Skill list/refresh, pending approval resolution, and MCP configuration/lifecycle. The API also exposes deterministic generate/execute/re-execute endpoints, Session compaction, context checkpoints, model calls, database query jobs, results, resources, and metrics. See the [API Reference](docs/sdk/api-reference.md).

## Development

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm test:ai-sql
pnpm test:ai-sql:performance
pnpm test:postgres
pnpm test:npm-package:functional
```

Live model tests are opt-in and may consume paid tokens:

```bash
pnpm test:functional:live
pnpm test:performance:live
```

Credentials belong in ignored environment files or an external secret store and must never be committed.

See the [test pipeline](docs/test-pipeline.md) for the three complex PostgreSQL scenarios, performance thresholds, evidence files, and complete release sequence.

## Current boundaries

- PostgreSQL is the only complete database connector in v1.
- Project guidance and Skills are the public v1 path for business rules; a stable CRUD API for resource-bound business knowledge is not exposed yet.
- The CLI accepts an OpenAI-compatible endpoint; native Anthropic Messages is available through the SDK and REST setup API.
- The WebUI is a lightweight local setup and evaluation surface, not an IDE.
- Interactive Agent results are capped at 1,000 rows and live only in the current response/in-process cache; restored Sessions contain no database rows. Re-run the SQL or use an explicit database export for later access.
- The default Runtime supports MCP secret references, but does not configure MCP OAuth or provide a credential vault.
- `shell_run` is not registered unless the host explicitly sets `enableShellTool: true`. It requires `full` mode, uses a Project-scoped working directory and a reduced environment, but still inherits the host process's OS permissions; it is not an operating-system sandbox.
- MCP servers are configured but not started automatically by default. Start reviewed servers explicitly, or opt into `autoStartMcp` only in a trusted host.
- Agent quality still depends on the selected model's reasoning and tool-calling behavior.
- AI governance and operations remain roadmap work and are not part of v1.

## Documentation

- [SDK Guide](docs/sdk/README.md)
- [SDK API Reference](docs/sdk/api-reference.md)
- [CLI Guide](docs/cli/README.md)
- [Product Functional Design](docs/product-functional-overview.md)
- [Agent and Extension Runtime](docs/agent/README.md)
- [Test Pipeline](docs/test-pipeline.md)
- [AI SQL Engineering Documentation](docs/ai-sql/README.md)
- [Security Policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)

## License

SchemaNaut is licensed under the [Apache License 2.0](LICENSE).
