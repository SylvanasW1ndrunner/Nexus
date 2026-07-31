# SchemaNaut SDK API Reference

[中文](api-reference.zh-CN.md) · [SDK Guide](README.md) · [Project README](../../README.md)

This reference documents the public v1 Node.js/TypeScript surface of `@nwlworkshop/schemanaut` and the main local REST endpoints.

SchemaNaut v1 provides AI SQL and common Agent infrastructure. It does not provide a governance/operations Agent or database IDE.

## `DatabaseAgentRuntime`

```ts
import { DatabaseAgentRuntime } from '@nwlworkshop/schemanaut';

const runtime = new DatabaseAgentRuntime(options);
```

### Constructor options

| Option                 | Type                                           | Default / purpose                                                     |
| ---------------------- | ---------------------------------------------- | --------------------------------------------------------------------- |
| `provider`             | `LlmProvider`                                  | Initial model provider; must be supplied together with `model`        |
| `gateway`              | `LlmGateway`                                   | Inject a custom model gateway                                         |
| `model`                | `string`                                       | Initial model ID; must be supplied together with `provider`           |
| `tenantId`             | `string`                                       | `"local-default"`                                                     |
| `driver`               | `IDatabaseDriver`                              | PostgreSQL driver compatibility boundary                              |
| `databaseAccess`       | `DatabaseAccessRuntime`                        | Inject the unified database runtime                                   |
| `connectors`           | `DatabaseConnector[]`                          | Additional database connectors                                        |
| `connectorRegistry`    | `ConnectorRegistry`                            | Inject a connector registry                                           |
| `resourceRegistry`     | `ResourceRegistry`                             | Inject a resource registry                                            |
| `credentialResolver`   | `CredentialResolver`                           | Resolve credential references for database profiles                   |
| `databaseAuditSink`    | `DatabaseAuditSink`                            | Receive lower-level database access audit events                      |
| `rag`                  | `SchemaRagEngine`                              | Inject a knowledge/retrieval engine                                   |
| `schemaSnapshotDirectory` | `string`                                    | Opt in to durable Schema RAG snapshots; relative to the Project root  |
| `retrievalProfile`     | `SchemaRagRetrievalProfile`                    | Configure lexical, embedding, reranking, and graph retrieval          |
| `createRunId`          | `() => string`                                 | Override generated deterministic SQL run IDs                          |
| `createConnectionId`   | `() => string`                                 | Override shortcut connection IDs                                      |
| `now`                  | `() => string`                                 | Override the ISO timestamp source                                     |
| `defaultRowLimit`      | `number`                                       | `200`; range 1–1,000                                                  |
| `usageTracker`         | `UsageTracker`                                 | Inject model usage accounting                                         |
| `approvalProvider`     | `ApprovalProvider`                             | Custom one-call approval callback; omit it to use the built-in broker |
| `agentDependencies`    | `AgentRunDependencies`                         | Inject Agent persistence/audit/checkpoint dependencies                |
| `sessionStore`         | `AgentSessionStore`                            | Inject a store; Runtime creates a Project-bound view over it           |
| `sessionDatabasePath`  | `string`                                       | OS user-data path from `defaultAgentStateDatabasePath()`              |
| `resultStore`          | `AiSqlResultStore`                             | Inject the bounded, ephemeral interactive-result cache                |
| `projectDirectory`     | `string`                                       | `process.cwd()`; selected Project root                                |
| `userSkillsDirectory`  | `string`                                       | `~/.schemanaut/skills`                                                |
| `sessionSkills`        | `SkillOverlay[]`                               | Default template copied into newly created Sessions                   |
| `webAdapter`           | `AgentWebAdapter`                              | Host-provided web search/fetch implementation                         |
| `enableShellTool`      | `boolean`                                      | `false`; register `shell_run` only for a trusted host                 |
| `dynamicToolDiscovery` | `boolean`                                      | `true`; expose discovery first and activate tools on demand           |
| `mcpSecretResolver`    | `(ref) => string \| undefined \| Promise<...>` | Resolve MCP environment/header secret references                      |
| `autoStartMcp`         | `boolean`                                      | `false`; opt in to starting reviewed `autoStart` MCP servers          |

### Public properties

| Property    | Type                    | Purpose                                                                         |
| ----------- | ----------------------- | ------------------------------------------------------------------------------- |
| `database`  | `DatabaseAccessRuntime` | Unified profiles, connections, discovery, query jobs, results, and transactions |
| `resources` | `ResourceRegistry`      | Unified resource graph and state                                                |
| `sessions`  | `AgentSessionStore`     | Durable Session history, preferences, exports, and context checkpoints          |
| `tools`     | `ToolRegistry`          | Built-in and dynamically registered Agent tools                                 |
| `skills`    | `SkillRegistry`         | Shared system, user, and Project Skills; Session views are Runtime-managed      |
| `results`   | `AiSqlResultStore`      | Trusted-host access to the bounded, expiring interactive-result cache           |
| `mcpConfig` | `McpConfigStore`        | Project `.schemanaut/mcp.json` management                                       |
| `mcp`       | `McpRuntimeManager`     | MCP lifecycle, health, tools, resources, and prompts                            |

The concrete extension types behind `tools`, `skills`, `results`, `mcpConfig`, and `mcp` may evolve during `0.1.x`; use the documented methods rather than their internal fields.

`webAdapter` is structural:

```ts
type AgentWebAdapter = {
  search(input: {
    query: string;
    limit: number;
    signal?: AbortSignal;
  }): Promise<Array<{ title: string; url: string; snippet?: string }>>;
  fetch(input: { url: string; maxChars: number; signal?: AbortSignal }): Promise<{
    url: string;
    title?: string;
    contentType?: string;
    text: string;
  }>;
};
```

## Runtime lifecycle and status

### `configureProvider(provider, model): void`

Registers or replaces the active provider/model pair.

### `status(): RuntimeStatus`

```ts
type RuntimeStatus = {
  providerConfigured: boolean;
  providerId?: string;
  model?: string;
  connected: boolean;
  connection?: SavedConnection;
  schema: SchemaIndexSnapshot;
  runCount: number;
  llm: {
    modelCount: number;
    metrics: LlmMetricsSnapshot;
  };
};
```

### `close(): Promise<void>`

Rejects new runs, aborts and waits for active Agent/subagent work, cancels pending broker approvals, stops running MCP servers, disconnects the shortcut connection, and closes the unified database runtime.

## Project helpers

### `initializeAgentProject(directory?): Promise<AgentProjectContext>`

Creates missing Project directories and default files without overwriting existing files:

- `.schemanaut/AGENT.md`
- `.schemanaut/settings.json`
- `.schemanaut/mcp.json`
- `.schemanaut/skills/`
- `sql/`
- `artifacts/`

### `findAgentProject(startPath?): Promise<AgentProjectContext | undefined>`

Walks upward from `startPath` and returns the nearest directory containing `.schemanaut`.

### `openAgentProject(startPath?): Promise<AgentProjectContext>`

Returns the nearest existing Project or creates an in-memory context for the selected directory. It does not initialize files.

### `defaultAgentStateDatabasePath(): string`

Returns the default OS user-data SQLite path.

### `defaultAgentUserSkillsDirectory(): string`

Returns `~/.schemanaut/skills`.

## PostgreSQL shortcut

### `testConnection(input): Promise<ConnectionTestResult>`

Tests a PostgreSQL connection without retaining it.

### `connect(input): Promise<SavedConnection>`

```ts
type PostgresConnectionInput = {
  id?: string;
  name?: string;
  host: string;
  port?: number; // default 5432
  database: string;
  username: string;
  password?: string;
  ssl?: boolean | 'require' | 'verify-ca' | 'verify-full';
  connectionTimeoutMs?: number; // default 10,000
  statementTimeoutMs?: number; // default 30,000
  readOnly?: boolean;
};
```

Passwords are passed to the connector but are not included in the public `SavedConnection`.

### `disconnect(): Promise<void>`

Disconnects the active shortcut connection.

## Knowledge index

### `indexSchema(options?): Promise<SchemaIndexSnapshot>`

```ts
type IndexSchemaOptions = {
  maxTables?: number; // default 200, range 1–1,000
};
```

```ts
type SchemaIndexSnapshot = {
  connectionId?: string;
  stage: 'not_connected' | 'not_indexed' | 'ready';
  ready: boolean;
  tableCount: number;
  columnCount: number;
  relationCount: number;
  documentCount: number;
  truncated: boolean;
  indexedAt?: string;
};
```

### `schemaStatus(): SchemaIndexSnapshot`

Returns current shortcut-index state without rebuilding it.

When `schemaSnapshotDirectory` is configured, successful indexes are restored for the same connection ID after restart. The persisted manifest retains the indexing limit and `truncated` semantics. The default unified PostgreSQL path compares a stable schema revision before `generate()` and `runAgent()` and refreshes changed external DDL automatically; custom compatibility drivers must call `indexSchema()` after out-of-band schema changes.

The snapshot directory contains plaintext Schema names, comments, business-glossary text, and derived vectors. SchemaNaut does not encrypt this directory. The embedding host owns its filesystem permissions, backups, retention, and secure deletion.

## AI SQL Agent

### `runAgent(input): Promise<AiSqlAgentRun>`

```ts
type RunAiSqlAgentInput = {
  message: string;
  userId?: string;
  mode?: 'read' | 'edit' | 'full'; // default read
  session?: AgentSession;
  sessionId?: string;
  sessionSkills?: SkillOverlay[]; // new Session only
  maxIterations?: number;
  maxToolExecutionMs?: number;
  onEvent?: (event: AgentUserEvent) => void | Promise<void>;
  signal?: AbortSignal;
};

type AiSqlAgentRun = {
  activatedSkills: string[];
  queryResults: InteractiveQueryResult[];
  result: AgentRunResult;
};
```

`session` and `sessionId` are mutually exclusive. A loaded Session must belong to the Runtime's Project. `sessionSkills` overrides the constructor default for one new Session; it cannot be supplied with `session` or `sessionId`. The overlay is persisted with the new Session, and restoration does not reapply a later Runtime default.

`AgentRunResult`:

```ts
type AgentRunResult = {
  runId: string;
  status: 'done' | 'aborted' | 'max_iterations_reached';
  session: AgentSession;
  finalText: string;
  iterations: number;
  toolExecutions: AgentToolExecutionRecord[];
  events?: AgentUserEvent[];
  artifacts?: AgentArtifactReference[];
  completion?: {
    verified: boolean;
    unresolvedTaskIds: string[];
    deliveryReady: boolean;
    finalResponseReady: boolean;
    phase: 'verify' | 'finalize' | 'done';
    missing: string[];
    evidenceKinds: string[];
  };
  contextCompression?: AgentContextCompressionReport[];
};
```

`runAgent()` is the trusted SDK integration surface. Its complete result includes tool execution records and other host-facing state.

For user-facing output, use `toAiSqlAgentRunView(run)` or the management methods below. The REST server applies this projection automatically:

```ts
type AgentSessionView = {
  id: string;
  title: string;
  userId?: string;
  mode: AgentMode;
  messages: Array<{
    role: 'user' | 'assistant';
    content: string;
    createdAt: string;
  }>;
  tokenUsage: LlmUsage;
  project?: { rootPath: string };
  taskPlan?: {
    goal: string;
    tasks: Array<{
      id: string;
      title: string;
      description?: string;
      status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
    }>;
  };
  artifacts?: AgentArtifactReference[];
  activeSkills?: SkillCatalogEntry[];
  aborted: boolean;
};

type AiSqlAgentRunView = {
  activatedSkills: string[];
  queryResults: InteractiveQueryResult[];
  result: {
    runId: string;
    status: AgentRunStatus;
    session: AgentSessionView;
    finalText: string;
    iterations: number;
    events?: AgentUserEvent[];
    artifacts?: AgentArtifactReference[];
    completion?: {
      verified: boolean;
      unresolvedTaskIds: string[];
      deliveryReady: boolean;
      finalResponseReady: boolean;
      phase: 'verify' | 'finalize' | 'done';
      missing: string[];
      evidenceKinds: string[];
    };
  };
};
```

`queryResults` contains at most 1,000 rows per SQL execution and is separate from `result.session`. The transient model projection defaults to at most 100 rows and 64 KiB, while honoring a smaller caller-requested preview. Query rows are not written to Session messages, durable Agent run records, or user preferences.

`AgentSessionView` omits tool messages/calls, query rows, knowledge hashes and tree identifiers, loaded Skill instructions, context-compression internals, and evaluation details. Its public task plan contains only the goal, step title/description, and status; acceptance rules, dependencies, and runtime evidence remain internal.

`getAgentRun(runId)` and `listAgentRuns(sessionId?, limit?)` expose Project-scoped, metadata-only Agent run records. A process restart converts an unfinished `running` record to `interrupted`; these records never contain database rows.

There is no user-selectable strategy field. Active Skill names are returned through `activatedSkills`.

### `AgentUserEvent`

```ts
type AgentUserEvent = {
  id: string;
  sessionId: string;
  type:
    | 'goal-understood'
    | 'plan-updated'
    | 'exploring'
    | 'sql-prepared'
    | 'approval-required'
    | 'sql-executed'
    | 'correcting'
    | 'artifact-created'
    | 'completed'
    | 'needs-user-input';
  message: string;
  createdAt: string;
  sql?: string;
  artifact?: AgentArtifactReference;
  metrics?: {
    durationMs?: number;
    rowCount?: number;
    affectedRows?: number;
  };
};
```

This is the user-visible semantic stream, not an internal reasoning/evaluation trace.

### `steerAgentSession(sessionId, message): boolean`

Queues an additional user requirement for an active run. Returns `false` when no run is active for that Session.

### Session management facade

```ts
listAgentSessions(input?: {
  userId?: string;
  archived?: boolean;
  query?: string;
  limit?: number;
  offset?: number;
}): Promise<AgentSessionListItem[]>;

getAgentSession(sessionId: string): Promise<AgentSessionView | undefined>;
deleteAgentSession(sessionId: string): Promise<boolean>;

type AgentSessionListItem = {
  id: string;
  title: string;
  userId?: string;
  mode: AgentMode;
  archived: boolean;
  conversationMessageCount: number;
  tokenUsage: LlmUsage;
  createdAt: string;
  updatedAt: string;
  lastMessageAt?: string;
};
```

`listAgentSessions()` returns durable, user-facing summaries. `conversationMessageCount` counts only user/assistant conversation messages; internal Tool-message counts are not exposed. `getAgentSession()` returns the de-internalized view above. `runtime.sessions.load()` is the lower-level trusted API for a complete `AgentSession`, but it remains bound to the Runtime's Project.

### `compactAgentSession(input): Promise<AgentContextCompactionResult>`

```ts
type CompactAiSqlAgentSessionInput = {
  session?: AgentSession;
  sessionId?: string;
  focus?: string;
  signal?: AbortSignal;
};
```

Creates a semantic working-context checkpoint when needed. The complete original Session transcript remains stored.

### `agentContextCheckpoints(sessionId, limit?): Promise<AgentContextCheckpoint[]>`

Returns durable checkpoints in sequence order. Store limit range is 1–1,000.

## Permission callback

```ts
type ApprovalProvider = (request: {
  mode: AgentMode;
  tool: AgentToolDefinition;
  toolCall: LlmToolCall;
  sessionId?: string;
  sessionTitle?: string;
  signal?: AbortSignal;
}) =>
  | boolean
  | Promise<boolean>
  | {
      approved: boolean;
      requestId?: string;
      approvedAt?: string;
      approvedBy?: string;
      reason?: string;
    }
  | Promise<{
      approved: boolean;
      requestId?: string;
      approvedAt?: string;
      approvedBy?: string;
      reason?: string;
    }>;
```

An approval applies to one tool call. A rejected call is recorded as denied and returned to the Agent as an observation.

If the constructor omits `approvalProvider`, the Runtime creates a built-in broker:

```ts
listAgentApprovals(): AgentApprovalRequest[];

resolveAgentApproval(
  requestId: string,
  approved: boolean,
  options?: { resolvedBy?: string; reason?: string },
): boolean;

type AgentApprovalRequest = {
  id: string;
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled';
  mode: AgentMode;
  sessionId?: string;
  sessionTitle?: string;
  toolCallId: string;
  toolName: string;
  dangerLevel: 'safe' | 'medium' | 'high' | 'critical';
  readonly: boolean;
  toolSource?: string;
  toolSourceId?: string;
  argumentPreview: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
  reason?: string;
};
```

The list method returns pending requests only. The default broker waits five minutes, redacts the argument preview, and limits it to 2,000 characters. `resolveAgentApproval()` returns `false` for an unknown/already-resolved request. A custom `approvalProvider` replaces this broker, so the facade does not own that callback's requests.

## `runtime.sessions`

`runtime.sessions` is a Project-bound view. Its Session reads and mutations include the normalized Project key in the SQLite query. It never treats a missing Project as globally visible. Existing rows with a persisted `session.project` are migrated to that Project; older rows without Project ownership remain readable only through an explicitly unbound `AgentSessionStore`, not through any `DatabaseAgentRuntime`.

| Method                                                  | Result                                                  |
| ------------------------------------------------------- | ------------------------------------------------------- |
| `save({ session, now? })`                               | Upserts a Session and returns its summary               |
| `load(id)`                                              | Returns the complete Session or `undefined`             |
| `list({ userId?, archived?, query?, limit?, offset? })` | Searches Session summaries; active Sessions by default  |
| `update(id, { title?, mode?, aborted? }, now?)`         | Updates selected Session fields                         |
| `archive(id, archived?, now?)`                          | Archives or restores a Session                          |
| `delete(id)`                                            | Deletes a Session and returns whether it existed        |
| `fork({ id, fromMessageIndex, newId?, title?, now? })`  | Creates an isolated branch through the selected message |
| `export(id, 'json' \| 'markdown')`                      | Exports the complete Session                            |
| `upsertPreference(input)`                               | Upserts a durable user preference                       |
| `listPreferences(userId, limit?)`                       | Lists preferences used for that user                    |
| `deletePreference(userId, key)`                         | Deletes one preference                                  |
| `listContextCheckpoints(sessionId, limit?)`             | Lists durable context checkpoints                       |

Session messages are stored in append-oriented SQLite tables. Recognized secret values are redacted before persistence.

When a Session has `userId`, explicit preference statements can be distilled during save and reused as a separate user-scoped context layer. Session transcripts remain isolated.

## `runtime.skills`

| Method                              | Purpose                                                    |
| ----------------------------------- | ---------------------------------------------------------- |
| `refresh()`                         | Reloads configured directories and Session overlays        |
| `list({ scope? })`                  | Returns catalog entries                                    |
| `catalogForModel()`                 | Returns only model-safe `name`, `description`, and `scope` |
| `get(nameOrLookup)`                 | Returns the selected catalog entry                         |
| `inspect(nameOrLookup)`             | Returns host-only source metadata                          |
| `load(nameOrLookup)`                | Loads the complete Markdown instructions                   |
| `search(query, { scope?, limit? })` | Searches the catalog                                       |
| `invoke('/skill args')`             | Parses and loads an explicit slash invocation              |
| `issues()` / `conflicts()`          | Returns load diagnostics                                   |
| `replaceSessionOverlay(overlays)`   | Replaces Session-scope `SKILL.md` content                  |
| `createSessionView(overlays)`       | Derives an isolated overlay view from the shared snapshot  |
| `currentRevision()`                 | Returns the current directory snapshot revision            |
| `watch(options)` / `stopWatching()` | Watches Skill sources                                      |

Scope precedence is `session > project > user > system`.

Public management shortcuts:

```ts
listAgentSkills(input?: { sessionId?: string }): Promise<AgentSkillCatalogEntry[]>;
refreshSkills(): Promise<AgentSkillRefreshResult>;
```

`listAgentSkills()` returns only the shared model-safe system/user/Project catalog. With an explicit `sessionId`, it loads that same-Project Session and returns its effective catalog; a missing or foreign-Project Session is rejected. `refreshSkills()` reloads only shared configured directories and returns `{ changed, revision, skills, issues, conflicts }`; it never imports an overlay from a Session.

The full trusted `AgentSession` contains its private `sessionSkills` payload for persistence. `AgentSessionView` and REST Agent responses omit that payload and all Skill instructions. v1 REST/CLI management does not provide a Session-overlay import or replacement endpoint.

## `runtime.mcpConfig`

| Method                           | Purpose                                                                |
| -------------------------------- | ---------------------------------------------------------------------- |
| `load()`                         | Loads `{ version: 1, servers }`                                        |
| `list()`                         | Lists normalized server configurations                                 |
| `upsert(input)`                  | Adds or updates a server                                               |
| `setEnabled(id, enabled)`        | Enables or disables a server                                           |
| `setAutoStart(id, autoStart)`    | Changes lazy autostart                                                 |
| `remove(id, { deleteSecrets? })` | Removes the config and optionally returns secret refs for host cleanup |

Supported transports are `stdio`, `streamable-http`, and `sse`. Sensitive environment variables and HTTP headers must use `{ ref: string }`; plaintext sensitive values are rejected.

## `runtime.mcp`

| Method                                              | Purpose                                      |
| --------------------------------------------------- | -------------------------------------------- |
| `start(serverId)` / `stop(serverId)`                | Starts or stops one configured server        |
| `startAutoStart()`                                  | Starts enabled servers marked `autoStart`    |
| `restartDue(now?)`                                  | Restarts servers whose health backoff is due |
| `health(serverId)` / `listHealth()`                 | Reads lifecycle health                       |
| `isRunning(serverId)`                               | Tests active state                           |
| `describe(serverId)` / `ping(serverId, signal?)`    | Reads server metadata or pings               |
| `listResources(serverId, signal?)`                  | Lists resources                              |
| `listResourceTemplates(serverId, signal?)`          | Lists resource templates                     |
| `readResource(serverId, uri, signal?)`              | Reads a resource                             |
| `listPrompts(serverId, signal?)`                    | Lists prompts                                |
| `getPrompt(serverId, name, args?, signal?)`         | Gets a prompt                                |
| `onResourcesChanged(...)` / `onPromptsChanged(...)` | Subscribes to list changes                   |

MCP tools are registered dynamically into `runtime.tools`. `startConfiguredMcpServers()` is a Runtime shortcut for starting configured `autoStart` servers.

Public MCP management:

```ts
listMcpServers(): Promise<McpServerSummary[]>;
upsertMcpServer(input: McpServerRegistrationInput): Promise<McpServerSummary>;
removeMcpServer(serverId: string): Promise<boolean>;
startMcpServer(serverId: string): Promise<McpServerStartSummary>;
stopMcpServer(serverId: string): Promise<McpServerStopSummary>;
startConfiguredMcpServers(): Promise<McpRuntimeStartResult[]>;

type McpServerStartSummary = {
  server: McpServerSummary;
  tools: string[];
};

type McpServerStopSummary = {
  serverId: string;
  removedTools: string[];
  status: McpServerStatus;
};

type McpServerSummary = {
  id: string;
  name: string;
  source: McpServerSource;
  transport: 'stdio' | 'sse' | 'streamable-http';
  enabled: boolean;
  autoStart: boolean;
  running: boolean;
  status: McpServerStatus;
  healthy: boolean;
  warnings: string[];
};
```

The summary intentionally omits command, URL, environment variables, headers, and Secret references. `McpServerRegistrationInput` accepts `id?`, `name`, `source?`, `transport?`, `autoStart?`, `enabled?`, `command?`, `args?`, `cwd?`, `url?`, `env?`, `headers?`, `description?`, and `packageName?`.

## `runtime.tools`

| Method                               | Purpose                                                      |
| ------------------------------------ | ------------------------------------------------------------ |
| `register(definition, handler)`      | Registers a tool; duplicate names throw                      |
| `unregister(name)`                   | Removes a tool                                               |
| `get(name)` / `list()` / `has(name)` | Reads registrations                                          |
| `llmTools(allowedTools?)`            | Projects model-visible names, descriptions, and JSON Schemas |

Definitions include danger level, source, read-only metadata, and static or argument-dependent required permission. Handlers receive the Session, abort signal, and one-call approval evidence.

Built-in names and required modes:

| Tools                                                                             | Required mode                                      |
| --------------------------------------------------------------------------------- | -------------------------------------------------- |
| `resource_list`, `resource_get`, `knowledge_search`, `sql_explain`                | `read`                                             |
| `sql_execute`                                                                     | Calculated from SQL: `read`, `edit`, or `full`     |
| `task_plan_create`, `task_update`, `task_list`, `tool_search`, `tool_describe`    | `read`                                             |
| `skill_search`, `skill_load`, `skill_resource_read`                               | `read`                                             |
| `workspace_list`, `workspace_read`, `workspace_search`                            | `read`                                             |
| `workspace_write`, `workspace_edit`                                               | `edit`                                             |
| `shell_run`                                                                       | `full`; registered only with `enableShellTool`     |
| `subagent_spawn`, `subagent_list`, `subagent_wait`                                | `read`                                             |
| `subagent_stop`                                                                   | `edit`                                             |
| `web_search`, `web_fetch`                                                         | `read`; present only when `webAdapter` is supplied |

Workspace file tools enforce the Project path boundary. An enabled `shell_run` restricts its working directory and receives a reduced environment, but it is not an OS sandbox.

The host-provided `webAdapter` is responsible for destination policy, credentials, rate limiting, and SSRF protection.

## `runtime.results`

| Method                                     | Purpose                                               |
| ------------------------------------------ | ----------------------------------------------------- |
| `put({ sessionId, connectionId, result })` | Stores only a bounded interactive result              |
| `read({ id, sessionId, cursor?, limit? })` | Reads cached rows; default 20, maximum 1,000 rows      |
| `listSession(sessionId)`                   | Lists current in-process results for one Session      |
| `remove(id)`                               | Removes one cached result                             |
| `clearSession(sessionId)`                  | Removes all cached results for a Session              |
| `prune()`                                  | Removes expired cached results                        |

This is a trusted-host compatibility surface, not an Agent Tool. The Agent has no `result_read` Tool and receives no cache ID. The cache contains at most the 1,000-row interactive payload, defaults to one hour, and is not restored with a Session. Use `AiSqlAgentRun.queryResults` for normal integration.

## Deterministic SQL generation and execution

### `generate(input): Promise<GeneratedSqlRun>`

```ts
type GenerateSqlInput = {
  question: string;
  maxContextChars?: number; // default 8,000; range 1,000–20,000
  signal?: AbortSignal;
};
```

The result contains `runId`, `status`, `question`, `sql`, `explanation`, `assumptions`, retrieval `evidence`, `safety`, timestamps, and optional usage.

Status is `awaiting_execution` only when the generated SQL passes the read-only safety check; otherwise it is `blocked`.

### `executeGenerated(runId, options?): Promise<ExecutedSqlRun>`

Executes an `awaiting_execution` run after rechecking it. `options.limit` defaults to `defaultRowLimit` and is limited to 1–1,000.

### `reexecuteGenerated(runId, options?): Promise<ExecutedSqlRun>`

Rechecks and re-executes a durable run whose status is `completed`, `failed`, `aborted`, or `outcome_unknown`. It requires the same database connection identity to be active. Use it when a restored run has `executionResultAvailable: false`.

### `getRun(runId): SqlRunSnapshot | undefined`

Returns the Project-scoped SQLite snapshot. Run metadata survives Runtime restart, but result rows do not. `executionResultAvailable` is `true` only on the immediate `executeGenerated()` or `reexecuteGenerated()` response. A stale `executing` record is recovered as `outcome_unknown` and is never replayed automatically.

## Direct model APIs

| Method                                                   | Purpose                                                       |
| -------------------------------------------------------- | ------------------------------------------------------------- |
| `llmChat(request, options?)`                             | One chat response                                             |
| `llmStream(request, options?)`                           | Async iterable of stream events                               |
| `submitLlmBatch(requests, { concurrency?, ...options })` | In-process asynchronous batch job                             |
| `getLlmJob(id)` / `cancelLlmJob(id)`                     | Reads or cancels a batch job                                  |
| `llmModels()`                                            | Returns registered model metadata                             |
| `discoverLlmModels()`                                    | Queries provider metadata/model listing without a test prompt |
| `llmMetrics()`                                           | Returns model metrics                                         |

The active Runtime model is inserted automatically; callers omit `model` from `llmChat`/`llmStream` requests.

## Lower-level database and resource APIs

`runtime.database` exposes the connector-neutral foundation used by the Agent:

- profiles: `createProfile`, `updateProfile`, `deleteProfile`, `getProfile`, `listProfiles`;
- connections: `testProfile`, `connect`, `reconnect`, `disconnect`, `health`;
- capabilities/discovery: `capabilities`, `discoverPage`, `discoverAll`;
- queries: `submit`, `getJob`, `cancel`, `readResult`, `releaseResult`;
- transactions: `beginTransaction`, savepoints, commit, rollback;
- resources: `queryResources`, `resourceRelations`, `snapshotResources`;
- lifecycle: `metrics`, `close`.

`runtime.resources` exposes resource upsert/query, graph relations and traversal, observations/state, events, snapshots, and restore.

These are general infrastructure APIs. They are not a v1 governance/operations Agent.

Result handles returned by `readResult` are temporary. Call `releaseResult(handleId)` after reading or exporting; disconnecting also clears handles for that profile. The PostgreSQL connector applies TTL, entry-count, and total-byte eviction as a fallback, and terminal query tracking in the runtime is bounded.

`ConnectionProfile.scope` optionally binds discovered resources to `tenantId`, `organizationId`, `projectId`, `environment`, and/or `region`. The database runtime propagates that scope to every discovered resource and rejects a connector that returns a conflicting scope. The SchemaNaut shortcut connection automatically binds its profile to the Runtime tenant and selected Project.

## Local REST API

The server defaults to `127.0.0.1:3721` and rejects non-loopback hosts. It validates `Host`, requires same-origin browser requests, and requires `application/json` for body-bearing mutation requests. Agent runs accept `maxIterations` from 1 to 64 and `maxToolExecutionMs` from 1 to 300,000.

### Embedded server lifecycle

The public `@nwlworkshop/schemanaut/server` subpath exports `startDatabaseAgentServer()`:

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
  port: 0,
  allowProcessMcpManagement: false,
});

console.log(started.url);
await started.close();
```

`port: 0` asks the operating system to allocate a free local port. The returned object exposes `server`, `runtime`, `host`, `port`, `url`, and an idempotent asynchronous `close()`. Closing stops request acceptance, cancels active request work, and waits for Runtime cleanup.

`allowProcessMcpManagement` defaults to `false`. Set it to `true` only in a trusted local embedding host that deliberately allows REST clients to launch configured stdio MCP child processes. Those commands inherit the host process's operating-system permissions; the option is not appropriate for an untrusted browser, remote client, or shared gateway.

### Main AI SQL flow

| Method and path                                          | Body / result                                                                                               |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `POST /v1/setup`                                         | `{ llm, database }`; configures provider and connects PostgreSQL                                            |
| `POST /v1/schema/index`                                  | `{ maxTables? }`; builds the knowledge index                                                                |
| `GET /v1/schema/status`                                  | Current `SchemaIndexSnapshot`                                                                               |
| `POST /v1/agent/run`                                     | `{ message, userId?, mode?, sessionId?, maxIterations?, maxToolExecutionMs? }`; returns `AiSqlAgentRunView` |
| `POST /v1/agent/run/stream`                              | Same body; semantic Server-Sent Events followed by a projected `result`                                     |
| `GET /v1/agent/runs?sessionId=&limit=`                   | Durable metadata-only Agent run records                                                                      |
| `GET /v1/agent/runs/:id`                                 | One durable Agent run record; `404` when absent                                                              |
| `POST /v1/agent/sessions/:id/compact`                    | `{ focus? }`; manual context compaction                                                                     |
| `GET /v1/agent/sessions/:id/context-checkpoints?limit=N` | Context checkpoint history                                                                                  |

The JSON run endpoint and the stream's final result use the de-internalized view. The SDK's `runAgent()` remains the complete trusted integration surface.

### Semantic Agent stream

`POST /v1/agent/run/stream` responds with `Content-Type: text/event-stream`. Each progress frame is:

```text
event: <AgentUserEvent.type>
data: <AgentUserEvent JSON>
```

Examples include `plan-updated`, `sql-prepared`, `sql-executed`, `correcting`, `approval-required`, and `completed`. Success ends with:

```text
event: result
data: <AiSqlAgentRunView JSON>
```

Failure ends with `event: error` and `{ "error": { "code", "message", "retryable" } }`. Closing the client connection aborts the active run.

### Agent management

| Method and path                             | Request / result                                                                              |
| ------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `GET /v1/agent/sessions`                    | Query: `userId?`, `query?`, `archived?`, `limit?`, `offset?`; returns Session summaries       |
| `GET /v1/agent/sessions/:id`                | Returns `AgentSessionView`; `404` when absent                                                 |
| `DELETE /v1/agent/sessions/:id`             | Returns `{ deleted }`; status `200` or `404`                                                  |
| `POST /v1/agent/sessions/:id/steer`         | `{ message }`; `202 { accepted: true }` or `409 { accepted: false, reason: "no-active-run" }` |
| `GET /v1/agent/skills`                      | Returns the model-safe Skill catalog                                                          |
| `POST /v1/agent/skills/refresh`             | Returns `{ changed, revision, skills, issueCount, conflictCount }`                            |
| `GET /v1/agent/approvals`                   | Returns pending broker-owned approval requests                                                |
| `POST /v1/agent/approvals/:id/resolve`      | `{ approved, resolvedBy?, reason? }`; returns `{ resolved: true, approved }`                  |
| `GET /v1/agent/mcp`                         | Returns `McpServerSummary[]` without commands, environment variables, headers, or secrets     |
| `POST /v1/agent/mcp`                        | Upserts `McpServerRegistrationInput`; returns `201` and the summary                           |
| `POST /v1/agent/mcp/:id/start` / `:id/stop` | Starts or stops one configured server                                                         |
| `DELETE /v1/agent/mcp/:id`                  | Stops if running, removes configuration, and returns `{ removed }`; status `200` or `404`     |

With the default broker, an `approval-required` event can be followed by `GET /v1/agent/approvals` and a resolve request while the stream stays open. The default wait is five minutes. When a custom `approvalProvider` is supplied, approval delivery belongs to that callback and the broker endpoints have no pending request.

REST process management for stdio MCP is disabled by default. A trusted local host must explicitly create the server with `allowProcessMcpManagement: true`; remote HTTP/SSE MCP still follows the normal URL, secret-reference, and transport checks.

### Deterministic flow

| Method and path           | Purpose                          |
| ------------------------- | -------------------------------- |
| `POST /v1/query/generate` | `{ question, maxContextChars? }` |
| `POST /v1/query/execute`  | `{ runId, limit? }`              |
| `POST /v1/query/reexecute` | `{ runId, limit? }`             |
| `GET /v1/runs/:id`        | Reads the durable run snapshot   |

### Model and database infrastructure

- model: `/v1/llm/provider-presets`, `/v1/llm/setup`, `/v1/llm/models`, `/v1/llm/chat`, `/v1/llm/chat/stream`, `/v1/llm/jobs`, `/v1/llm/metrics`;
- database: `/v1/database/profiles`, `/v1/database/connectors`, `/v1/database/queries`, `/v1/database/results`, `/v1/database/transactions`;
- resources: `/v1/resources`, `/v1/resources/traverse`, `/v1/resource-events`;
- service: `/health`, `/v1/status`, `/v1/capabilities`.

Success responses are JSON. Errors use:

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable message",
    "retryable": false
  }
}
```

SchemaNaut provides no user-account, registration, or login system. The embedding host application or gateway is responsible for identity authentication and API access control. SchemaNaut also provides no persistent secret vault.

Resource read endpoints accept the same scope fields as query parameters. In a shared service, the host must derive or validate those fields from authenticated identity rather than trusting arbitrary client-supplied tenant or Project IDs.

## Errors

`DatabaseAgentError` has:

```ts
type DatabaseAgentErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_CONFIGURED'
  | 'CONNECTION_FAILED'
  | 'SCHEMA_NOT_INDEXED'
  | 'LLM_REQUEST_FAILED'
  | 'LLM_RESPONSE_INVALID'
  | 'SQL_BLOCKED'
  | 'RUN_NOT_FOUND'
  | 'RUN_NOT_EXECUTABLE'
  | 'QUERY_FAILED'
  | 'ABORTED'
  | 'INTERNAL_ERROR';
```

Properties:

```ts
{
  code: DatabaseAgentErrorCode;
  message: string;
  retryable: boolean;
  detail?: string;
}
```

Lower-level database access errors use `DatabaseAccessRuntimeError`; resource conflicts use `ResourceConflictError`; public contract violations use `ContractValidationError`.

## Public contracts and exports

Top-level exports include:

- model providers, gateway, registry, router, usage, cache, probe, and preset APIs;
- `DatabaseAccessRuntime`, `ConnectorRegistry`, `PostgresConnector`, and connector contract verification;
- `ResourceRegistry` and resource snapshot stores;
- versioned contract validators and lossless portable JSON helpers;
- connection, query, result, transaction, capability, resource, and observation domain types;
- `AgentSession`, `AgentMode`, `AgentUserEvent`, Project helpers, and context-checkpoint types;
- user-facing Agent run/Session views and Session, Skill, approval, and MCP management contracts.

See the generated TypeScript declarations in the package for the complete structural types.
