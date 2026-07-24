# SchemaNaut SDK API Reference

[中文](api-reference.zh-CN.md) · [SDK Guide](README.md) · [Project README](../../README.md)

- Package: `@nwlworkshop/schemanaut`
- Module format: ESM
- Minimum runtime: Node.js 22.5
- Current API version: `0.1.0` (alpha)

This document describes the supported top-level exports and the public objects reachable from `DatabaseAgentRuntime`.

## `DatabaseAgentRuntime`

```ts
new DatabaseAgentRuntime(options?: DatabaseAgentRuntimeOptions)
```

### Constructor options

| Option | Type | Purpose |
| --- | --- | --- |
| `provider` | `LlmProvider` | Initial model provider; must be paired with `model` |
| `gateway` | `LlmGateway` | Inject an existing LLM gateway |
| `model` | `string` | Initial model identifier; must be paired with `provider` |
| `tenantId` | `string` | Tenant key for model telemetry and policy context; default `local-default` |
| `driver` | `IDatabaseDriver` | Compatibility database driver override |
| `databaseAccess` | `DatabaseAccessRuntime` | Inject the full unified database runtime |
| `connectors` | `DatabaseConnector[]` | Additional/replacement connectors |
| `connectorRegistry` | `ConnectorRegistry` | Inject a connector registry |
| `resourceRegistry` | `ResourceRegistry` | Inject the product-wide resource registry |
| `credentialResolver` | `CredentialResolver` | Resolve credential references outside public profiles |
| `databaseAuditSink` | `DatabaseAuditSink` | Receive database audit events |
| `rag` | `SchemaRagEngine` | Inject a knowledge/retrieval engine |
| `retrievalProfile` | `SchemaRagRetrievalProfile` | Configure lexical, embedding, rerank, graph, and context behavior |
| `createRunId` | `() => string` | Deterministic/custom SQL run ID factory |
| `createConnectionId` | `() => string` | Deterministic/custom shortcut connection ID factory |
| `now` | `() => string` | ISO timestamp factory for deterministic tests |
| `defaultRowLimit` | `number` | Shortcut execution limit, 1–1,000; default 200 |
| `usageTracker` | `UsageTracker` | Inject shared usage accounting |
| `approvalProvider` | `ApprovalProvider` | Handle requests beyond the current Agent mode |
| `agentDependencies` | `AgentRunDependencies` | Inject Agent stores, clocks, IDs, audit, and checkpoint dependencies |
| `sessionStore` | `AgentSessionStore` | Inject a durable/custom Session store |
| `sessionDatabasePath` | `string` | SQLite path; default `.schemanaut/schemanaut.db` |
| `resultStore` | `AiSqlResultStore` | Inject the paged Agent result store |

If only one of `provider` or `model` is supplied, construction throws `DatabaseAgentError` with code `INVALID_INPUT`.

### Public properties

| Property | Type | Notes |
| --- | --- | --- |
| `database` | `DatabaseAccessRuntime` | Connector-neutral database/warehouse/cluster runtime |
| `resources` | `ResourceRegistry` | Same instance as `database.resources` |
| `sessions` | `AgentSessionStore` | Durable Agent sessions, preferences, exports, and checkpoints |
| `tools` | `ToolRegistry` | Built-in Agent tool registry |
| `skills` | `SkillRegistry` | Built-in and application-registered Skill registry |
| `results` | `AiSqlResultStore` | Session-isolated, expiring result handles for Agent tools |

`tools`, `skills`, and `results` are public extension/evaluation surfaces in `0.1.x`; their detailed concrete types are not re-exported as stable top-level package APIs yet.

### Configuration and lifecycle

#### `configureProvider(provider, model): void`

Registers the provider and selected model. It can be called after construction and can replace the active high-level model selection.

#### `status(): RuntimeStatus`

Returns provider/model configuration, active shortcut connection, Schema index state, SQL run count, registered model count, and LLM metrics.

#### `close(): Promise<void>`

Disconnects the shortcut connection, closes the unified database runtime, and clears in-memory SQL runs. Call once during shutdown.

### PostgreSQL shortcut

#### `testConnection(input): Promise<ConnectionTestResult>`

Tests a PostgreSQL connection without retaining a session.

#### `connect(input): Promise<SavedConnection>`

Opens the active PostgreSQL shortcut connection. Input:

```ts
type PostgresConnectionInput = {
  id?: string;
  name?: string;
  host: string;
  port?: number; // default 5432
  database: string;
  username: string;
  password?: string;
  ssl?: boolean | 'prefer' | 'require' | 'verify-ca' | 'verify-full';
  connectionTimeoutMs?: number; // default 10,000
  statementTimeoutMs?: number;  // default 30,000
  readOnly?: boolean;
};
```

#### `disconnect(): Promise<void>`

Disconnects the active shortcut connection, removes its knowledge index, and clears high-level SQL runs.

### Knowledge index

#### `indexSchema(options?): Promise<SchemaIndexSnapshot>`

Builds or refreshes the active connection's knowledge catalog and retrieval index.

```ts
type IndexSchemaOptions = { maxTables?: number }; // 1–1,000; default 200
```

#### `schemaStatus(): SchemaIndexSnapshot`

Returns `not_connected`, `not_indexed`, or `ready`, plus table, column, relation, and document counts.

### AI SQL Agent

#### `runAgent(input): Promise<AiSqlAgentRun>`

```ts
type RunAiSqlAgentInput = {
  message: string;                    // 1–4,000 characters
  userId?: string;
  mode?: 'read' | 'edit' | 'full';   // default read
  session?: AgentSession;
  sessionId?: string;
  maxIterations?: number;
  maxToolExecutionMs?: number;
  signal?: AbortSignal;
};
```

Returns:

```ts
type AiSqlAgentRun = {
  selectedSkill: string;
  result: AgentRunResult;
};
```

`AgentRunResult` includes status, complete Session, final text, iteration count, tool execution records, and optional context-compression reports.

#### `compactAgentSession(input): Promise<AgentContextCompactionResult>`

Manually creates a semantic checkpoint for a Session. Provide `session` or `sessionId`, with optional `focus` and `signal`.

#### `agentContextCheckpoints(sessionId, limit?): Promise<AgentContextCheckpoint[]>`

Returns ordered context checkpoints. The store accepts a limit from 1 to 1,000.

### Generate and execute

#### `generate(input): Promise<GeneratedSqlRun>`

```ts
type GenerateSqlInput = {
  question: string;         // 1–4,000 characters
  maxContextChars?: number; // 1,000–20,000; default 8,000
  signal?: AbortSignal;
};
```

Returns SQL, explanation, assumptions, evidence, safety report, timestamps, optional usage, and status `awaiting_execution` or `blocked`.

#### `executeGenerated(runId, options?): Promise<ExecutedSqlRun>`

Executes an `awaiting_execution` run with `{ limit?: number }`. The limit is 1–1,000. The deterministic shortcut only executes a single read-only `SELECT`, `WITH`, or `VALUES` statement accepted by the safety analyzer.

#### `getRun(runId): SqlRunSnapshot | undefined`

Returns a clone of the current in-memory SQL run record.

### Direct model calls

#### `llmChat(request, options?): Promise<LlmChatResponse>`

`request` is `LlmGatewayChatRequest` without `model`; the configured model is added automatically.

Common options:

```ts
type LlmRuntimeCallOptions = {
  taskType?: string;
  userId?: string;
  policies?: LlmPolicyLayers;
  budget?: LlmBudgetLimits;
  timeoutMs?: number;
  maxRetries?: number;
  maxFallbacks?: number;
  cache?: { enabled: boolean; ttlMs?: number; namespace?: string };
};
```

#### `llmStream(request, options?): AsyncIterable<LlmChatStreamEvent>`

Streams text deltas, tool-call deltas, usage, and finish events.

#### `submitLlmBatch(requests, options?): LlmAsyncJob<LlmGatewayResult>`

Submits an asynchronous batch. Options also accept `concurrency`.

#### `getLlmJob(id)` / `cancelLlmJob(id)`

Reads or cancels an asynchronous LLM job.

#### `llmModels(): RegisteredLlmModel[]`

Returns the local model registry.

#### `discoverLlmModels(): Promise<RegisteredLlmModel[]>`

Queries provider model/metadata APIs only. Discovery failures are recorded as unknown health instead of sending validation prompts.

#### `llmMetrics(): LlmMetricsSnapshot`

Returns request, token, latency, failure, retry, cache, and related aggregate metrics.

## `runtime.sessions`

| Method | Result |
| --- | --- |
| `save({ session, now? })` | Upserts a Session and returns its summary |
| `load(id)` | Loads the complete Session or `undefined` |
| `list(filter?)` | Lists summaries by user, archive state, text query, limit, and offset |
| `update(id, patch, now?)` | Changes title, mode, or aborted state |
| `archive(id, archived?, now?)` | Archives or restores a Session |
| `delete(id)` | Deletes a Session and returns whether it existed |
| `fork({ id, fromMessageIndex, newId?, title?, now? })` | Creates a Session branch through the selected message |
| `export(id, 'json' \| 'markdown')` | Exports the complete Session |
| `upsertPreference(input)` | Creates or updates a user preference |
| `listPreferences(userId, limit?)` | Returns preferences ordered by confidence and recency |
| `deletePreference(userId, key)` | Deletes one preference |
| `listContextCheckpoints(sessionId, limit?)` | Returns durable compaction checkpoints |

Session messages are stored separately in append-oriented SQLite tables. Persisted values pass through secret redaction.

## `runtime.tools`

| Method | Purpose |
| --- | --- |
| `register(definition, handler)` | Registers a unique Agent tool |
| `unregister(name)` | Removes a tool |
| `get(name)` | Gets a registered tool |
| `list()` | Lists registered tools |
| `has(name)` | Checks registration |
| `llmTools(allowedTools?)` | Projects only model-visible names, descriptions, and JSON Schemas |

A tool definition includes `name`, `description`, `inputSchema`, `dangerLevel`, optional `readonly`, source metadata, and required permission. The handler receives arguments plus Session, abort signal, and approval evidence.

## `runtime.skills`

| Method | Purpose |
| --- | --- |
| `register(skill)` / `unregister(name)` | Manages Skill definitions |
| `get(name)` / `list()` | Reads Skills |
| `filterToolsForSkill(name, availableTools)` | Applies the Skill allowlist |
| `createExecutionPlan(name, userInput, availableTools)` | Builds a concrete plan |
| `findMatchingSkills(options)` | Ranks matching Skills |
| `createAutoExecutionPlan(options)` | Chooses and plans the best match |

The runtime registers a small set of built-in, product-level workflow Skills. Application Skills should remain explicit about their allowed tools.

## `runtime.results`

| Method | Purpose |
| --- | --- |
| `put({ sessionId, connectionId, result })` | Stores a result under an expiring handle |
| `read({ id, sessionId, cursor?, limit? })` | Reads a session-isolated page |
| `remove(id)` | Removes a result |
| `clearSession(sessionId)` | Removes all results for a Session |
| `prune()` | Removes expired results |

Default result TTL is one hour. Results cannot be read from another Session.

## `DatabaseAccessRuntime`

`runtime.database` exposes the following connector-neutral methods.

### Profiles and connections

- `createProfile(profile)`
- `updateProfile(profileId, patch)`
- `deleteProfile(profileId)`
- `getProfile(profileId)`
- `listProfiles()`
- `testProfile(profileId, credential?)`
- `connect(profileId, credential?)`
- `reconnect(profileId, credential?)`
- `disconnect(profileId)`
- `health(profileId)`
- `getSession(sessionId)`
- `getSessionForProfile(profileId)`
- `capabilities(profileId)`

Profiles contain endpoint, principal, purpose, scope, and connector metadata. Secrets belong in a supplied credential, credential reference, or `CredentialResolver`.

### Discovery and resources

- `discoverPage(profileId, request?)`
- `discoverAll(profileId, request?)`
- `queryResources(query?)`
- `resourceRelations(resourceId)`
- `snapshotResources()`

### Query jobs and results

- `submit(submission): Promise<QueryJob>`
- `getJob(jobId): Promise<QueryJob>`
- `cancel(jobId): Promise<QueryJob>`
- `readResult(handleId, { cursor?, limit? }): Promise<ResultBatch>`
- `streamResult(handleId, { batchSize? }): AsyncIterable<ResultBatch>`

`QuerySubmission` supports sync/async execution, parameters, transaction/session binding, timeout, row/batch limits, dry-run/confirmation, cost limits, authorization, labels, and priority.

### Transactions

- `beginTransaction(profileId, options?)`
- `createSavepoint(transactionId, name)`
- `rollbackToSavepoint(transactionId, name)`
- `commitTransaction(transactionId)`
- `rollbackTransaction(transactionId)`

### Observations, operations, and audit

- `observe(request): Promise<ResourceObservation[]>`
- `operate(request): Promise<DatabaseOperationResult>`
- `listAuditEvents({ profileId?, limit? })`
- `metrics(): DatabaseAccessMetrics`
- `close(): Promise<void>`

Operations are connector-declared atomic actions with a risk level and required capability. Authorization is carried in the request rather than inferred from the model.

## `ResourceRegistry`

The stable resource/state API includes:

- Mutation: `upsertResource`, `upsertRelation`, `addObservation`, `applyDiscoveryPage`, `applyChangeSet`
- Lookup: `getResource`, `getRelation`, `query`, `relationsFor`, `neighbors`, `traverse`
- State: `observationsFor`, `resolveFact`, `state`, `events`
- Lifecycle: `markResourceDeleted`, `restoreResource`, `markRelationDeleted`, `restoreRelation`
- Identity: `bindResources`
- Persistence: `snapshot`, `restore`, `clear`

Exported persistence implementations:

- `InMemoryResourceSnapshotStore`
- `JsonFileResourceSnapshotStore`

Exported identity helpers:

- `createStableResourceId`
- `createStableRelationId`
- `createResourceObservation`

## Model exports

### Providers

- `OpenAICompatibleProvider`
- `createSiliconFlowProvider`
- `AnthropicProvider`
- `LLM_PROVIDER_PRESETS`
- `getLlmProviderPreset`
- `createProviderFromPreset`

### Gateway and infrastructure

The package also exports the LLM platform from the top-level entrypoint, including `LlmGateway`, `LlmRouter`, model registry, task routing, structured-output validation, prompt runtime, response cache, reliability, telemetry, budget, asynchronous jobs, and their public types.

Use `DatabaseAgentRuntime` wrappers unless the application needs multiple custom providers/models or platform-level routing.

## Errors

### `DatabaseAgentError`

Fields: `code`, `message`, `retryable`, optional `detail`.

Codes:

- `INVALID_INPUT`
- `NOT_CONFIGURED`
- `CONNECTION_FAILED`
- `SCHEMA_NOT_INDEXED`
- `LLM_REQUEST_FAILED`
- `LLM_RESPONSE_INVALID`
- `SQL_BLOCKED`
- `RUN_NOT_FOUND`
- `RUN_NOT_EXECUTABLE`
- `QUERY_FAILED`
- `ABORTED`
- `INTERNAL_ERROR`

`asDatabaseAgentError(error)` converts unknown, abort, and LLM provider failures into this high-level error.

Other exported error classes include `DatabaseAccessRuntimeError`, `ContractValidationError`, `ResourceConflictError`, `ResourceSnapshotStoreError`, and LLM platform errors such as `LlmProviderError`.

## Public contracts and transport helpers

### Contract versioning

- `CURRENT_CONTRACT_VERSION`
- `SUPPORTED_CONTRACT_VERSIONS`
- `createContractEnvelope`
- `assertContractEnvelope`

### Validators

- `assertConnectionProfile`
- `assertDatabaseAccessError`
- `assertNoSecretMaterial`
- `assertPortableValue`
- `assertQuerySubmission`
- `assertResourceChangeSet`
- `assertResourceDescriptor`
- `assertResourceObservation`
- `assertResourceRegistrySnapshot`
- `assertResourceRelation`

### Portable JSON

- `toPortableValue`
- `fromPortableValue`
- `stringifyPublicJson`
- `parsePublicJson`

Portable JSON preserves supported values such as `bigint`, binary data, and dates across the public transport contract instead of silently degrading them.

### Connector development

- `ConnectorRegistry`
- `CapabilityResolver`
- `DATABASE_CAPABILITIES`
- `PostgresConnector`
- `verifyConnectorContract`

The connector types exported from the package include `DatabaseConnector`, `ConnectorManifest`, `ConnectorContext`, `DiscoveryRequest`, transaction options, credential and audit abstractions, and connector certification reports.

## Exported domain types

The top-level package exports the high-level SDK types from `packages/sdk/src/types.ts`, all public LLM platform types, and the following public contract families:

- Connections: `ConnectionProfile`, `ConnectionSession`, `ConnectionHealth`, `DatabaseEndpoint`, `DatabaseCredential`
- Capabilities: `CapabilityProfile`, `CapabilityDescriptor`, `CapabilityRequirement`, `CapabilityConstraint`, `CapabilityCheck`
- Queries: `QuerySubmission`, `QueryJob`, `ResultHandle`, `ResultBatch`, `DatabaseTransaction`
- Operations: `DatabaseObservationRequest`, `DatabaseOperationDescriptor`, `DatabaseOperationRequest`, `DatabaseOperationResult`, `DatabaseAuditEvent`
- Resources: `ResourceDescriptor`, `ResourceRelation`, `ResourceObservation`, `ResourceQuery`, `ResourceTraversalRequest`, `ResourceStateSnapshot`, `ResourceRegistrySnapshot`, change/event/source types
- Transport: `ContractEnvelope`, `PortableValue`, `PortableScalar`, `PortableTaggedValue`, `PublicErrorBase`

The TypeScript declarations inside the package are the authoritative compile-time source for exact nested fields.
