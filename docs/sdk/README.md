# SchemaNaut SDK Guide

[中文](README.zh-CN.md) · [API Reference](api-reference.md) · [Project README](../../README.md)

This guide shows how to use SchemaNaut v1 through the TypeScript SDK, local REST API, and CLI. All examples describe the current source API.

SchemaNaut v1 is an AI SQL Agent, not a database IDE and not an AI governance/operations Agent.

## 1. Requirements and installation

- Node.js 22.13 or newer (durable Sessions use `node:sqlite`; the `--experimental-sqlite` startup flag is not required, but Node 22 still labels the module experimental)
- ESM application, or a build tool that consumes ESM
- PostgreSQL
- An OpenAI-compatible endpoint or Anthropic Messages endpoint
- A model with tool calling for `runAgent()`

The public npm package is not published yet. Build and install the archive locally:

```bash
pnpm install
pnpm package:npm
npm install ./release/SchemaNaut-v0.1.0/schemanaut-v0.1.0.tgz
```

The planned package name is `@nwlworkshop/schemanaut`.
CLI examples use `npx schemanaut` so they resolve the command from this local installation.

## 2. Runtime, Project, and Session

These concepts have different lifecycles:

- `DatabaseAgentRuntime` owns model providers, the active database connection, knowledge index, tools, Skills, MCP clients, bounded interactive results, and Session access.
- A Project is a selected directory containing reusable instructions and extensions. Pass it as `projectDirectory`.
- A Session is one isolated, durable conversation. Its messages, task plan, artifacts, active tools and Skills, token usage, and context checkpoints are stored together.

By default, Session state is stored in the OS user-data directory returned by `defaultAgentStateDatabasePath()`, not inside the Project:

- Windows: `%LOCALAPPDATA%\SchemaNaut\schemanaut.db`
- Linux/macOS fallback: `~/.local/share/SchemaNaut/schemanaut.db`

Set `sessionDatabasePath` when an application needs a dedicated state file.
Multiple Projects may safely share one state file. The Runtime binds its Session store to the normalized `projectDirectory`; list, load, update, archive, delete, fork, export, compaction, checkpoint, Skill lookup, resume, and REST/CLI Session operations are filtered by that Project in SQLite. A foreign Project receives the same not-found result as an unknown Session.

Initialize a Project once:

```ts
import { initializeAgentProject } from '@nwlworkshop/schemanaut';

const project = await initializeAgentProject('/srv/acme-data');
console.log(project.configDirectory);
```

The resulting layout is:

```text
acme-data/
├── .schemanaut/
│   ├── AGENT.md
│   ├── settings.json
│   ├── mcp.json
│   └── skills/
├── sql/
└── artifacts/
```

`.schemanaut/AGENT.md` contains reusable project guidance. Do not put credentials in it. A Session is bound to its Project and cannot be resumed through a Runtime opened on a different Project.

## 3. Create and close a Runtime

```ts
import { DatabaseAgentRuntime, createProviderFromPreset } from '@nwlworkshop/schemanaut';

const apiKey = process.env.LLM_API_KEY;
if (!apiKey) throw new Error('LLM_API_KEY is required');

const runtime = new DatabaseAgentRuntime({
  tenantId: 'acme',
  projectDirectory: '/srv/acme-data',
  sessionDatabasePath: '/srv/acme-state/schemanaut.db',
  provider: createProviderFromPreset('siliconflow', {
    apiKey,
  }),
  model: process.env.LLM_MODEL!,
});

try {
  // Connect, index, and run work here.
} finally {
  await runtime.close();
}
```

Call `close()` during application shutdown. It cancels pending broker approvals, stops running MCP servers, disconnects the shortcut PostgreSQL connection, and closes the unified database runtime.

## 4. Configure a model provider

### Presets

OpenAI-compatible presets are available for `siliconflow`, `deepseek`, `zhipu`, `moonshot`, `ollama`, and `vllm`:

```ts
import { createProviderFromPreset } from '@nwlworkshop/schemanaut';

const apiKey = process.env.LLM_API_KEY;
if (!apiKey) throw new Error('LLM_API_KEY is required');

const cloud = createProviderFromPreset('deepseek', {
  apiKey,
});

const local = createProviderFromPreset('ollama', {
  baseUrl: 'http://127.0.0.1:11434/v1',
});
```

Preset capabilities are metadata, not a live prompt-based capability test. `runtime.discoverLlmModels()` queries the provider's model metadata/list endpoint without sending a capability-test message.

### OpenAI-compatible gateways and relay services

Most relay services differ from an official OpenAI-compatible service only by endpoint, model name, and authentication. Configure those explicitly:

```ts
import { OpenAICompatibleProvider } from '@nwlworkshop/schemanaut';

const apiKey = process.env.LLM_API_KEY;
if (!apiKey) throw new Error('LLM_API_KEY is required');

const provider = new OpenAICompatibleProvider({
  id: 'company-gateway',
  name: 'Company gateway',
  baseUrl: process.env.LLM_BASE_URL!,
  apiKey,
  timeoutMs: 60_000,
  maxRetries: 1,
});
```

Set `allowUnauthenticated: true` only for a trusted endpoint that requires no key.

### Anthropic Messages

```ts
import { AnthropicProvider } from '@nwlworkshop/schemanaut';

const provider = new AnthropicProvider({
  apiKey: process.env.ANTHROPIC_API_KEY!,
});
```

Provider and model can also be configured after construction:

```ts
runtime.configureProvider(provider, 'model-id');
const models = await runtime.discoverLlmModels();
const status = runtime.status();
```

## 5. Connect PostgreSQL and index Schema

```ts
const connectionInput = {
  host: process.env.DB_HOST ?? '127.0.0.1',
  port: Number(process.env.DB_PORT ?? 5432),
  database: process.env.DB_NAME!,
  username: process.env.DB_USER!,
  password: process.env.DB_PASSWORD,
  ssl: false,
  readOnly: true,
  connectionTimeoutMs: 10_000,
  statementTimeoutMs: 30_000,
};

const test = await runtime.testConnection(connectionInput);
console.log(test.latencyMs, test.readOnly);

const connection = await runtime.connect(connectionInput);
const schema = await runtime.indexSchema({ maxTables: 500 });
console.log(connection.id, schema.tableCount, schema.columnCount);
```

`connect()` replaces the previous shortcut connection. `indexSchema()` accepts 1–1,000 relations; its default is 200. Set `schemaSnapshotDirectory` in the Runtime options to persist successful indexes; relative paths are resolved from the selected Project root.

Snapshot files are application data, not an encrypted secret store. They contain plaintext Schema names, comments, business-glossary text, and derived vectors. The embedding host must restrict directory access and define its own backup, retention, and secure-deletion policy.

The knowledge layer uses a database → schema → relation → column hierarchy. It supports exact/full-text retrieval, relationship expansion, and optional embedding/reranking. Choose an embedding model that covers both the user's language and database identifiers; SchemaNaut does not force a Chinese-only model.

Successful DDL executed through the built-in Agent SQL tool refreshes the active index. The default unified PostgreSQL path also compares a stable schema revision before SQL generation and Agent runs, so external DDL is refreshed automatically. Hosts using a custom compatibility `driver` must call `indexSchema()` after out-of-band schema changes.

## 6. Run the plan-guided AI SQL Agent

```ts
const run = await runtime.runAgent({
  userId: 'user-42',
  message: 'Extract channel from the Kafka event JSON and calculate paid revenue by day this week.',
  mode: 'read',
  maxIterations: 12,
  maxToolExecutionMs: 30_000,
  onEvent: async (event) => {
    console.log(event.type, event.message);
    if (event.sql) console.log(event.sql);
  },
});

console.log(run.activatedSkills);
console.log(run.result.status);
console.log(run.result.finalText);
console.log(run.result.session.id);
console.log(run.result.completion);
```

The SDK is a trusted integration surface: `runAgent()` returns the complete `AiSqlAgentRun`, including tool execution records and context-compression reports when present. Use the public Session management methods described below for a user-facing projection. The local REST API always returns that de-internalized projection.

`runAgent()` uses one adaptive, plan-guided ReAct loop:

1. understand the goal;
2. create or update a task plan when useful;
3. discover and activate only the required Skills and tools;
4. retrieve Schema or inspect small data samples;
5. generate and execute SQL;
6. observe database errors or results and change course;
7. verify task evidence before reporting completion.

There is no user-selectable Agent strategy. `activatedSkills` is the list actually active in the returned Session.

The `onEvent` callback receives user-facing semantic events only:

```text
goal-understood
plan-updated
exploring
sql-prepared
approval-required
sql-executed
correcting
artifact-created
completed
needs-user-input
```

Internal reasoning, knowledge hashes, node IDs, ranking scores, and evaluation traces are intentionally not projected into this event stream.

## 7. Built-in project tools and subagents

The Runtime registers general tools in addition to database and knowledge tools:

- `workspace_list`, `workspace_read`, and `workspace_search` read Project files;
- `workspace_write` and `workspace_edit` create or modify Project files and register artifacts;
- `shell_run` runs a bounded command only when the host opts in with `enableShellTool: true`;
- `web_search` and `web_fetch` are registered only when the host provides `webAdapter`;
- `subagent_spawn`, `subagent_list`, `subagent_wait`, and `subagent_stop` manage bounded child tasks.

Dedicated file tools reject absolute paths, traversal outside the Project, and symlink escapes. `shell_run` is not registered by default. When enabled, its working directory must be inside the Project and its child environment is reduced to ordinary operating-system variables, but the process still inherits the SchemaNaut host's OS permissions. It is not an OS sandbox.

The host web adapter is also the network policy boundary. It must enforce the application's destination allowlist, authentication, rate limits, and SSRF protections.

A child Agent has the same generic Runtime capabilities and Project reference, but an independent conversation context and only the delegated goal. The parent receives its status, summary, and artifact references rather than the child's full context.

## 8. Permission and approval

`runAgent()` accepts `read`, `edit`, or `full`:

| Mode   | Automatic authority                                                              |
| ------ | -------------------------------------------------------------------------------- |
| `read` | Schema inspection and read-only SQL                                              |
| `edit` | `read` plus row changes, Project file changes, and other non-destructive edits   |
| `full` | `edit` plus DDL, destructive actions, shell commands, and administrative actions |

When a tool requires more authority than the mode, `approvalProvider` is called:

```ts
const runtime = new DatabaseAgentRuntime({
  provider,
  model,
  approvalProvider: async ({ mode, tool, toolCall, sessionId }) => {
    const approved = await showApprovalDialog({
      mode,
      sessionId,
      toolName: tool.name,
      arguments: toolCall.arguments,
    });

    return approved
      ? {
          approved: true,
          requestId: crypto.randomUUID(),
          approvedBy: 'operator-7',
          approvedAt: new Date().toISOString(),
        }
      : false;
  },
});
```

Approval is evidence for that tool call only. Rejection is returned to the Agent as an observation; it may replan or explain what additional authority is required.

When `approvalProvider` is omitted, the Runtime installs a built-in approval broker. This is the simplest path for a WebUI or REST host:

```ts
const pending = runtime.listAgentApprovals();

if (pending[0]) {
  const resolved = runtime.resolveAgentApproval(pending[0].id, true, {
    resolvedBy: 'operator-7',
    reason: 'Reviewed in the operations console.',
  });
  console.log(resolved);
}
```

`listAgentApprovals()` returns pending requests only. The broker waits up to five minutes by default; its argument preview is redacted and limited to 2,000 characters. Supplying a custom `approvalProvider` replaces the broker, so these management methods then return no broker-owned requests.

Application modes do not override database grants. Use a least-privilege PostgreSQL account, and remember that `readOnly: true` at connection time prevents writes even if Agent mode is `edit` or `full`.

## 9. Continue, steer, and compact Sessions

Resume a Session by ID:

```ts
const continued = await runtime.runAgent({
  sessionId: run.result.session.id,
  message: 'Break that down by channel and compare it with last week.',
  mode: 'read',
});
```

Pass `session` or `sessionId`, never both. Transcripts, plans, and artifacts are isolated between Sessions. Query rows are not Session state at all: they are returned separately for the current run and disappear across restart. Session IDs are Project-scoped, so even `runtime.sessions`, the low-level management facade, cannot read or mutate a Session owned by another Project. When `userId` is present, explicit statements from the user may be distilled into the preference layer and reused by other Sessions for that same user; Tool output and database samples are never preference sources. Manage preferences with `runtime.sessions.listPreferences()`, `upsertPreference()`, and `deletePreference()`.

If a run is still active, add a new user requirement without starting another run. The event supplies the Session ID even for a newly created Session:

```ts
let steered = false;

const running = runtime.runAgent({
  message: 'Analyze weekly paid revenue and explain abnormal changes.',
  mode: 'read',
  onEvent: (event) => {
    if (!steered && event.type === 'exploring') {
      steered = runtime.steerAgentSession(event.sessionId, 'Exclude internal test tenants.');
    }
  },
});

const steeredRun = await running;
```

`steerAgentSession()` returns `false` if that Session does not currently have an active run.

Use the public management facade for application screens and APIs:

```ts
const sessions = await runtime.listAgentSessions({
  userId: 'user-42',
  query: 'revenue',
  archived: false,
  limit: 20,
  offset: 0,
});

const view = await runtime.getAgentSession(run.result.session.id);
const deleted = await runtime.deleteAgentSession('obsolete-session-id');
```

Session list items expose `conversationMessageCount`, which counts user/assistant messages only. `getAgentSession()` returns `AgentSessionView`: user/assistant messages, public plan evidence, artifacts, active Skill catalog entries, token usage, and basic Project data. It deliberately omits tool messages and calls, knowledge hashes and tree IDs, Skill instructions, and other integration-only state. `runtime.sessions.load()` remains the trusted low-level API for loading the complete Session.

SchemaNaut keeps the original Session transcript. Near the model context limit it can mask old tool outputs and create a semantic checkpoint for the model's working context. Trigger the same mechanism manually:

```ts
const compacted = await runtime.compactAgentSession({
  sessionId: run.result.session.id,
  focus: 'Preserve exact SQL, confirmed definitions, decisions, and unfinished tasks.',
});

const checkpoints = await runtime.agentContextCheckpoints(run.result.session.id, 20);
```

Common Session Store methods:

```ts
const recent = await runtime.sessions.list({
  userId: 'user-42',
  archived: false,
  query: 'revenue',
  limit: 20,
});
const session = await runtime.sessions.load(run.result.session.id);
const markdown = await runtime.sessions.export(run.result.session.id, 'markdown');
const fork = await runtime.sessions.fork({
  id: run.result.session.id,
  fromMessageIndex: run.result.session.messages.length - 1,
  title: 'Alternative definition',
});
```

Session persistence redacts recognized secret material. Do not deliberately place credentials in messages.

## 10. Separate, bounded query results

Database aggregation, filtering, joins, window functions, and anomaly calculations should stay in PostgreSQL. `runAgent()` returns database data beside the Agent result:

```ts
for (const result of run.queryResults) {
  console.log(result.columns);
  console.table(result.rows); // at most 1,000 rows
  console.log({ returned: result.returnedRowCount, hasMore: result.hasMore });
}
```

The SDK/API/CLI payload contains at most 1,000 rows per execution. The transient model-only projection defaults to at most 100 rows and 64 KiB, while honoring a smaller caller-requested preview. Neither payload is written to conversation messages, durable Session history, Agent run history, or user preferences. `hasMore: true` means the database produced more rows than the interactive limit.

The in-process cache contains only that bounded interactive payload and expires automatically. A restored Session therefore has no historical rows. Re-execute the SQL when an interactive result is needed again. For a complete export, use the lower-level database query/export path or ask the Agent to create an export artifact; stream the database result directly to the destination rather than routing it through the conversation.

## 11. Skills

SchemaNaut uses standard Markdown Skill bundles:

```text
.schemanaut/skills/order-revenue/
└── SKILL.md
```

```markdown
---
name: order-revenue
description: Calculate paid order revenue using the project's confirmed business definition.
license: Apache-2.0
metadata:
  owner: data-team
---

# Order revenue

Use paid_at as the payment time. Exclude test tenants. Let PostgreSQL perform all aggregation.
```

The parent directory and frontmatter `name` must match and use lowercase letters, numbers, and single hyphens.

Skill precedence is:

```text
session > project > user > system
```

Locations and inputs:

- system: bundled with SchemaNaut;
- user: `~/.schemanaut/skills/<name>/SKILL.md` by default;
- project: `<project>/.schemanaut/skills/<name>/SKILL.md`;
- Session: in-memory overlays persisted with one Session in its SQLite record.

The Runtime constructor's `sessionSkills` value is a default template copied into every newly created Session. `runAgent({ sessionSkills })` overrides that template for one new Session. A restored Session always keeps its persisted overlay; supplying `sessionSkills` together with `session` or `sessionId` is rejected instead of silently replacing it.

Only `name`, `description`, and `scope` are included in the initial model catalog. The Markdown body is loaded when the Agent activates the Skill. Invoke one explicitly with `/order-revenue task text` or `/project:order-revenue task text`.

```ts
const runtime = new DatabaseAgentRuntime({
  // Default for new Sessions only.
  sessionSkills: [
    {
      content: `---
name: temporary-rule
description: Apply the temporary reporting rule for this Session.
---

Use UTC boundaries for this task.`,
    },
  ],
});

const run = await runtime.runAgent({
  message: '/temporary-rule build the report',
  sessionSkills: [
    {
      content: `---
name: temporary-rule
description: Apply a different rule only in this new Session.
---

Use the tenant's local calendar day.`,
    },
  ],
});
const sharedSkills = await runtime.listAgentSkills();
const effectiveSessionSkills = await runtime.listAgentSkills({
  sessionId: run.result.session.id,
});
const refreshed = await runtime.refreshSkills();
console.table(sharedSkills);
console.table(effectiveSessionSkills);
console.log(refreshed.changed, refreshed.revision);
```

`listAgentSkills()` returns only the shared system/user/Project catalog and therefore cannot leak a Session overlay. Pass an explicit, same-Project `sessionId` to return that Session's effective model-safe catalog. `refreshSkills()` reloads only the shared directories; Session overlays remain immutable Session snapshots. `runtime.skills` is the shared registry and exposes `list()`, `get()`, `inspect()`, `load()`, `search()`, `invoke()`, `issues()`, and `conflicts()` for trusted host diagnostics.

In v1, Session overlay import is an SDK capability through constructor options or a new `runAgent()` call. The REST and CLI management surfaces list and refresh Skills but do not import or replace Session overlays.

## 12. MCP

SchemaNaut's MCP client is built on the official Model Context Protocol SDK. It supports:

- stdio;
- Streamable HTTP;
- legacy SSE compatibility;
- tools, resources, resource templates, and prompts;
- pagination and list-change notifications;
- cancellation, timeouts, result-size limits, health state, and cleanup.

Configure project servers in `.schemanaut/mcp.json`:

```json
{
  "version": 1,
  "servers": [
    {
      "id": "catalog",
      "name": "Internal catalog",
      "source": "user",
      "transport": "streamable-http",
      "url": "https://mcp.example.com/mcp",
      "enabled": true,
      "autoStart": true,
      "headers": {
        "Authorization": { "ref": "mcp/catalog/authorization" }
      }
    }
  ]
}
```

Sensitive environment variables and headers must be references, not plaintext. Resolve them in the host:

```ts
const runtime = new DatabaseAgentRuntime({
  projectDirectory: '/srv/acme-data',
  mcpSecretResolver: async (ref) => {
    return await secretStore.get(ref);
  },
});
```

`autoStartMcp` defaults to `false`. Configuration discovery never starts a process or opens a remote connection by itself. Start reviewed servers explicitly, call `startConfiguredMcpServers()`, or set `autoStartMcp: true` only in a trusted host. You can manage them through the public Runtime facade:

```ts
const server = await runtime.upsertMcpServer({
  id: 'local-tools',
  name: 'Local tools',
  transport: 'stdio',
  command: 'node',
  args: ['./mcp-server.mjs'],
  enabled: true,
  autoStart: false,
});

const started = await runtime.startMcpServer(server.id);
console.log(started.tools);
console.table(await runtime.listMcpServers());
await runtime.stopMcpServer(server.id);
await runtime.removeMcpServer(server.id);
```

`listMcpServers()` returns lifecycle/health summaries and intentionally omits commands, environment variables, headers, and Secret references. `upsertMcpServer()` accepts stdio, Streamable HTTP, or SSE configuration. `startConfiguredMcpServers()` starts enabled servers marked `autoStart`. The lower-level `runtime.mcpConfig` and `runtime.mcp` properties remain available to trusted hosts that need resource, prompt, health, or configuration details.

When dynamic discovery is enabled—the default—the Agent starts with discovery tools and activates matching MCP tools only when needed. This avoids placing every tool Schema in every prompt.

## 13. Deterministic generate-then-execute

Use `generate()` when the application, not the Agent, should control the execution boundary:

```ts
const generated = await runtime.generate({
  question: 'Find the ten customers with the highest paid revenue this month.',
});

console.log(generated.sql);
console.log(generated.safety);
console.log(generated.evidence);

if (generated.status === 'awaiting_execution') {
  const executed = await runtime.executeGenerated(generated.runId, {
    limit: 100,
  });
  console.table(executed.execution.rows);
}
```

Generated SQL run metadata survives a Runtime restart in the Project-scoped SQLite state database, but result rows do not. `executionResultAvailable` is `true` only on the immediate execution response. A restored completed run reports `executionResultAvailable: false`; reconnect the same database and call `reexecuteGenerated(runId, { limit })` to obtain a new bounded result.

This path only executes a single read-only statement. Use `runAgent()` with the appropriate mode for row changes or DDL.

## 14. Direct model and lower-level database APIs

The same Runtime exposes:

- `llmChat()`, `llmStream()`, and `submitLlmBatch()`;
- `llmModels()`, `discoverLlmModels()`, and `llmMetrics()`;
- `runtime.database` for connection profiles, resources, query jobs, paged results, cancellation, and transactions;
- `runtime.resources` for the unified resource graph and state snapshots.

These are integration primitives. Their presence does not mean v1 includes a governance/operations Agent.

See the [API Reference](api-reference.md) for signatures and limits.

## 15. Local REST API

Start the service:

```bash
npx schemanaut serve --host 127.0.0.1 --port 3721
```

Configure model and database:

```bash
curl -X POST http://127.0.0.1:3721/v1/setup \
  -H "content-type: application/json" \
  -d '{
    "llm": {
      "protocol": "openai-compatible",
      "baseUrl": "https://your-endpoint/v1",
      "apiKey": "...",
      "model": "your-model"
    },
    "database": {
      "host": "127.0.0.1",
      "port": 5432,
      "database": "app",
      "username": "app_reader",
      "password": "..."
    }
  }'

curl -X POST http://127.0.0.1:3721/v1/schema/index \
  -H "content-type: application/json" \
  -d '{ "maxTables": 500 }'

curl -X POST http://127.0.0.1:3721/v1/agent/run \
  -H "content-type: application/json" \
  -d '{
    "userId": "user-42",
    "mode": "read",
    "message": "Show paid revenue by day for the last seven days."
  }'
```

`POST /v1/agent/run` returns `AiSqlAgentRunView`, not the SDK's full `AiSqlAgentRun`. Its Session contains only user-facing messages and state; tool messages/calls, retrieval internals, Skill instructions, and evaluation data are not exposed.

For live progress, use the semantic SSE endpoint:

```bash
curl -N -X POST http://127.0.0.1:3721/v1/agent/run/stream \
  -H "content-type: application/json" \
  -d '{
    "userId": "user-42",
    "mode": "read",
    "message": "Show paid revenue by day for the last seven days."
  }'
```

Each progress frame uses `event: <AgentUserEvent.type>` and a JSON `data:` payload. Typical event names include `plan-updated`, `sql-prepared`, `sql-executed`, `correcting`, `approval-required`, and `completed`. A successful stream ends with `event: result` whose data is `AiSqlAgentRunView`; failure ends with `event: error` and `{ "error": { "code", "message", "retryable" } }`. Disconnecting aborts the active run.

Agent management endpoints:

| Area      | Endpoints                                                                                                                                                                                   |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sessions  | `GET /v1/agent/sessions`, `GET/DELETE /v1/agent/sessions/:id`, `POST /v1/agent/sessions/:id/steer`, `POST /v1/agent/sessions/:id/compact`, `GET /v1/agent/sessions/:id/context-checkpoints` |
| Skills    | `GET /v1/agent/skills`, `POST /v1/agent/skills/refresh`                                                                                                                                     |
| Approvals | `GET /v1/agent/approvals`, `POST /v1/agent/approvals/:id/resolve` with `{ approved, resolvedBy?, reason? }`                                                                                 |
| MCP       | `GET/POST /v1/agent/mcp`, `POST /v1/agent/mcp/:id/start`, `POST /v1/agent/mcp/:id/stop`, `DELETE /v1/agent/mcp/:id`                                                                         |

When the stream emits `approval-required`, a UI can list the pending request and resolve it while the stream remains open. This works with the Runtime's default broker; a server wired to a custom `approvalProvider` owns approval delivery itself.

The service is intentionally loopback-only. It validates the HTTP `Host`, requires browser origins to be same-origin, and requires JSON content types for body-bearing mutation requests. Process-based stdio MCP management is disabled through REST unless the trusted host explicitly enables `allowProcessMcpManagement`; remote HTTP/SSE MCP remains available subject to normal MCP validation. SchemaNaut deliberately provides no user-account, registration, or login system; the embedding host application or gateway owns identity authentication and API access control. SchemaNaut also does not provide a persistent secret vault.

An embedding application can start and close the same server through the public server subpath:

```ts
import { DatabaseAgentRuntime } from '@nwlworkshop/schemanaut';
import { startDatabaseAgentServer } from '@nwlworkshop/schemanaut/server';

const runtime = new DatabaseAgentRuntime({
  tenantId: 'acme',
  projectDirectory: '/srv/acme-data',
});

const started = await startDatabaseAgentServer({
  runtime,
  host: '127.0.0.1',
  port: 3721,
  // Keep false unless this is a trusted local host that intentionally
  // permits REST clients to launch stdio MCP child processes.
  allowProcessMcpManagement: false,
});

console.log(started.url);

try {
  // The local REST service is available here.
} finally {
  await started.close();
}
```

`startDatabaseAgentServer()` rejects non-loopback hosts. `started.close()` stops accepting requests, cancels active request work, and waits for Runtime cleanup. Set `allowProcessMcpManagement: true` only in a trusted local embedding host: a configured stdio MCP command runs with that host process's operating-system permissions. It is not a switch for an untrusted browser, remote client, or shared gateway.

## 16. Interactive CLI

```bash
npx schemanaut init ./acme-data
npx schemanaut skills -C ./acme-data
npx schemanaut sessions -C ./acme-data
npx schemanaut chat -C ./acme-data
```

`chat` reads:

```text
SCHEMANAUT_LLM_BASE_URL
SCHEMANAUT_LLM_API_KEY          # optional for local Ollama
SCHEMANAUT_LLM_MODEL
SCHEMANAUT_DATABASE_URL
SCHEMANAUT_MAX_SCHEMA_TABLES    # optional, default 500
SCHEMANAUT_STATE_DATABASE_PATH  # optional
```

The CLI first loads `<project>/.env` and then reads these names. Existing process environment values take precedence. Invalid lines report only the line number and error category, never the source value. Copying the repository `.env.example` therefore produces the exact CLI contract.

The PostgreSQL URL accepts `sslmode=disable|require|verify-ca|verify-full`. `require` encrypts without certificate verification, `verify-ca` validates the certificate chain, and `verify-full` additionally validates the hostname. PostgreSQL `prefer` fallback is intentionally rejected because the Node runtime cannot guarantee its downgrade semantics.

Inside chat:

```text
/mode read|edit|full
/new
/resume <session-id>
/sessions
/skills
/<skill> [task]
/compact [focus]
/trace on|off
/mcp [list|start <id>|stop <id>]
/exit
```

Ordinary input during an active run steers the current task. `Ctrl+C` cancels the run while preserving Session state.

## 17. Cancellation, errors, and secrets

Pass an `AbortSignal` to `runAgent()`, `generate()`, `compactAgentSession()`, direct model calls, and supported lower-level operations.

SDK errors use `DatabaseAgentError` with:

```ts
{
  code: string;
  message: string;
  retryable: boolean;
  detail?: string;
}
```

Rules for a host application:

- keep model keys and database passwords outside Project files, Skills, Session messages, SQL, logs, and source control;
- resolve MCP secret references through an external secret store;
- use a least-privilege database account;
- use either the default approval broker or a custom `approvalProvider` wherever users or organizational policy must approve actions;
- treat `full` mode as host command-execution authority, not only database DDL authority;
- leave `enableShellTool` and REST `allowProcessMcpManagement` disabled unless the deployment explicitly needs and trusts them;
- treat user-provided Skills, MCP servers, and project instructions as executable configuration that requires trust review.

## 18. Further reading

- [SDK API Reference](api-reference.md)
- [CLI Guide](../cli/README.md)
- [Agent and Extension Runtime](../agent/README.md)
- [AI SQL Engineering Documentation](../ai-sql/README.md)
- [Product Functional Design](../product-functional-overview.md)
- [Security Policy](../../SECURITY.md)
