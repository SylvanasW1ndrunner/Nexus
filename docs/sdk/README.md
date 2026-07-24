# SchemaNaut SDK Guide

[中文](README.zh-CN.md) · [API Reference](api-reference.md) · [Project README](../../README.md)

This guide covers the public Node.js/TypeScript SDK shipped as `@nwlworkshop/schemanaut`.

> The package name is planned but not published to npm yet. Build and install the local archive while the project is in alpha.

## 1. Requirements and installation

- Node.js 22.5 or newer
- ESM application or a build tool that can consume ESM
- PostgreSQL for the current complete reference connector
- A tool-capable LLM for Agent workflows

```bash
pnpm install
pnpm package:npm
npm install ./release/SchemaNaut-v0.1.0/schemanaut-v0.1.0.tgz
```

The package contains JavaScript, TypeScript declarations, the CLI, bilingual README and SDK documentation, license files, and third-party notices.

## 2. Runtime lifecycle

`DatabaseAgentRuntime` is the main entrypoint. A typical lifecycle is:

1. Create a model provider and runtime.
2. Test or open a database connection.
3. Build the Schema knowledge index.
4. Run the Agent or generate SQL.
5. Inspect results, audit records, resources, and metrics.
6. Call `close()` during application shutdown.

```ts
import {
  DatabaseAgentRuntime,
  createProviderFromPreset,
} from '@nwlworkshop/schemanaut';

const runtime = new DatabaseAgentRuntime({
  tenantId: 'local-team',
  provider: createProviderFromPreset('siliconflow', {
    apiKey: process.env.LLM_API_KEY,
  }),
  model: process.env.LLM_MODEL!,
});

try {
  // Use the runtime.
} finally {
  await runtime.close();
}
```

If `sessionDatabasePath` is omitted, Agent sessions are stored in `.schemanaut/schemanaut.db` under the process working directory.

## 3. Model providers

### Provider presets

The built-in presets are `siliconflow`, `deepseek`, `zhipu`, `moonshot`, `ollama`, and `vllm`.

```ts
import { createProviderFromPreset } from '@nwlworkshop/schemanaut';

const cloud = createProviderFromPreset('deepseek', {
  apiKey: process.env.LLM_API_KEY,
  timeoutMs: 60_000,
  maxRetries: 1,
});

const local = createProviderFromPreset('ollama', {
  baseUrl: 'http://127.0.0.1:11434/v1',
});
```

Presets declare known protocol capabilities. `discoverLlmModels()` reads the provider's model list and metadata endpoint; it does not send a capability-test prompt.

### Generic OpenAI-compatible endpoint

```ts
import { OpenAICompatibleProvider } from '@nwlworkshop/schemanaut';

const provider = new OpenAICompatibleProvider({
  id: 'private-gateway',
  name: 'Private gateway',
  baseUrl: process.env.LLM_BASE_URL!,
  apiKey: process.env.LLM_API_KEY,
  allowUnauthenticated: false,
  timeoutMs: 60_000,
  maxRetries: 1,
});
```

For a private endpoint without authentication, set `allowUnauthenticated: true`.

### Anthropic Messages

```ts
import { AnthropicProvider } from '@nwlworkshop/schemanaut';

const provider = new AnthropicProvider({
  apiKey: process.env.ANTHROPIC_API_KEY!,
});
```

### Configure or replace a provider later

```ts
runtime.configureProvider(provider, 'your-model-id');
const models = await runtime.discoverLlmModels();
const status = runtime.status();
```

## 4. PostgreSQL shortcut

The high-level shortcut is the simplest way to use the first reference connector.

```ts
const input = {
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

const test = await runtime.testConnection(input);
console.log(test.latencyMs, test.readOnly);

const connection = await runtime.connect(input);
console.log(connection.id);
```

`connect()` disconnects the previous shortcut connection before opening a new one. Passwords are passed to the connector but are not stored in the public connection profile.

## 5. Build and refresh the knowledge index

```ts
const snapshot = await runtime.indexSchema({ maxTables: 500 });
console.log(snapshot);
```

The public shortcut accepts 1–1,000 relations per indexing run. The default is 200. The knowledge layer builds a hierarchical catalog and retrieval index from discovered resources and relations.

When an Agent SQL tool changes Schema, the built-in integration refreshes the active index. If Schema changes outside SchemaNaut, call `indexSchema()` again before the next Agent run. Use `schemaStatus()` to check readiness.

An optional retrieval profile can bind embedding and reranking to model providers already registered in the LLM gateway:

```ts
const runtime = new DatabaseAgentRuntime({
  provider,
  model: process.env.LLM_MODEL!,
  retrievalProfile: {
    id: 'bilingual-schema',
    version: 1,
    backend: { type: 'memory', bm25K1: 1.2, bm25B: 0.75 },
    embedding: {
      providerInstanceId: 'private-gateway',
      modelId: process.env.EMBEDDING_MODEL!,
      dimensions: 1024,
      normalization: 'l2',
      distanceMetric: 'cosine',
      requestTemplateVersion: '1',
    },
    defaultLimit: 8,
    defaultMaxContextTokens: 1_500,
    graphHops: 1,
    rrfK: 60,
  },
});
```

Use an embedding model appropriate for both the user's natural language and the identifiers stored in the database. The SDK does not force a Chinese-only embedding model.

## 6. Run the AI SQL Agent

```ts
const first = await runtime.runAgent({
  userId: 'user-42',
  message: '从 Kafka 事件表的 JSON value 中提取渠道，统计本周每天的支付金额。',
  mode: 'read',
  maxIterations: 12,
  maxToolExecutionMs: 30_000,
});

console.log(first.selectedSkill);
console.log(first.result.status);
console.log(first.result.finalText);
console.table(first.result.toolExecutions);
```

The Agent receives tool results intended for the task. Internal catalog hashes, node identifiers, and tree indexes remain inside the knowledge implementation and are not part of the model-facing retrieval result.

### Continue a session

```ts
const continued = await runtime.runAgent({
  sessionId: first.result.session.id,
  message: '按渠道再拆分，并说明异常波动。',
  mode: 'read',
});
```

Pass either `session` or `sessionId`, never both.

### Permission and approval

```ts
const runtime = new DatabaseAgentRuntime({
  provider,
  model,
  approvalProvider: async ({ mode, tool, toolCall, sessionId }) => {
    return await requestApprovalInYourApplication({
      mode,
      toolName: tool.name,
      arguments: toolCall.arguments,
      sessionId,
    });
  },
});
```

`approvalProvider` may return a boolean or:

```ts
{
  approved: true,
  requestId: 'approval-123',
  approvedBy: 'operator-7',
  approvedAt: new Date().toISOString(),
  reason: 'Reviewed in the change workflow',
}
```

Without an approval provider, an action outside the active `read`, `edit`, or `full` mode remains unapproved.

## 7. Session history and context compaction

The durable SQLite store keeps the complete message history. Context compaction changes only the model's active working view.

```ts
const compacted = await runtime.compactAgentSession({
  sessionId: first.result.session.id,
  focus: 'Keep exact SQL, exact result values, user decisions, and unfinished tasks.',
});

const checkpoints = await runtime.agentContextCheckpoints(
  first.result.session.id,
  20,
);
```

The runtime also compacts automatically when the active prompt approaches the selected model's physical context window. If model summarization fails, a deterministic fallback preserves continuity.

The session store is available as `runtime.sessions`:

```ts
const recent = await runtime.sessions.list({ userId: 'user-42', limit: 20 });
const session = await runtime.sessions.load(first.result.session.id);
const exported = await runtime.sessions.export(first.result.session.id, 'json');
const forked = await runtime.sessions.fork({
  id: first.result.session.id,
  fromMessageIndex: first.result.session.messages.length - 1,
  title: 'Alternative analysis',
});
```

It also supports update, archive, delete, user preferences, and checkpoint queries. See the API reference for the method list.

## 8. Deterministic SQL generation and execution

`generate()` uses retrieved Schema context but does not execute the result.

```ts
const generated = await runtime.generate({
  question: 'Top ten active customers by paid revenue this month',
  maxContextChars: 12_000,
});

console.log({
  sql: generated.sql,
  explanation: generated.explanation,
  assumptions: generated.assumptions,
  evidence: generated.evidence,
  safety: generated.safety,
});
```

Only a run with status `awaiting_execution` can be passed to `executeGenerated()`:

```ts
if (generated.status === 'awaiting_execution') {
  const executed = await runtime.executeGenerated(generated.runId, {
    limit: 200,
  });
  console.table(executed.execution.rows);
}
```

This shortcut deliberately accepts only one read-only statement. Use `runAgent()` with the appropriate mode for edits or DDL.

## 9. Direct LLM APIs

### Chat

```ts
const reply = await runtime.llmChat(
  {
    messages: [{ role: 'user', content: 'Explain this query plan.' }],
  },
  {
    taskType: 'query-plan-explanation',
    userId: 'user-42',
    timeoutMs: 30_000,
    maxRetries: 1,
    cache: { enabled: true, ttlMs: 60_000 },
  },
);
```

### Stream

```ts
for await (const event of runtime.llmStream({
  messages: [{ role: 'user', content: 'Analyze the lock graph.' }],
})) {
  if (event.type === 'text-delta') process.stdout.write(event.text);
}
```

### Asynchronous batch

```ts
const job = runtime.submitLlmBatch(
  [
    { messages: [{ role: 'user', content: 'Summarize query A' }] },
    { messages: [{ role: 'user', content: 'Summarize query B' }] },
  ],
  { concurrency: 2 },
);

const current = runtime.getLlmJob(job.id);
runtime.cancelLlmJob(job.id);
```

Use `llmModels()`, `discoverLlmModels()`, and `llmMetrics()` for the model catalog and call metrics.

## 10. Unified database runtime

`runtime.database` is the connector-neutral API for databases, warehouses, and clusters. The current package registers the PostgreSQL TCP connector.

```ts
const now = new Date().toISOString();

runtime.database.createProfile({
  id: 'analytics-readonly',
  name: 'Analytics PostgreSQL',
  connectorId: 'postgres-native',
  engine: 'postgres',
  endpoints: [{
    transport: 'tcp',
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 5432),
    database: process.env.DB_NAME!,
  }],
  principal: process.env.DB_USER!,
  purpose: 'read-only',
  readOnly: true,
  createdAt: now,
  updatedAt: now,
});

await runtime.database.connect('analytics-readonly', {
  username: process.env.DB_USER!,
  password: process.env.DB_PASSWORD,
});

await runtime.database.discoverAll('analytics-readonly');

const job = await runtime.database.submit({
  profileId: 'analytics-readonly',
  sql: 'select current_database() as database_name',
  executionMode: 'sync',
  timeoutMs: 5_000,
  rowLimit: 100,
});

if (job.result) {
  const page = await runtime.database.readResult(job.result.id, {
    limit: 100,
  });
  console.table(page.rows);
}
```

The same runtime exposes capability resolution, health, query cancellation, sticky transactions and savepoints, observations, atomic operations, audit events, metrics, and resource snapshots.

## 11. Resources and state

`runtime.resources` and `runtime.database.resources` are the same registry.

```ts
const tables = runtime.resources.query({
  kinds: ['table'],
  engine: 'postgres',
  limit: 100,
});

for (const table of tables.items) {
  const state = runtime.resources.state(table.id);
  const relations = runtime.resources.relationsFor(table.id);
  console.log(table.canonicalName, state, relations);
}
```

The registry supports resources, relations, observations, graph traversal, derived facts, lifecycle events, snapshots, restore, and controlled identity binding.

## 12. Cancellation and errors

All long-running high-level Agent, generation, and compaction calls accept an `AbortSignal`.

```ts
const controller = new AbortController();
const pending = runtime.runAgent({
  message: 'Analyze all query patterns.',
  mode: 'read',
  signal: controller.signal,
});

controller.abort();
await pending;
```

Catch `DatabaseAgentError` for the high-level runtime:

```ts
import { DatabaseAgentError } from '@nwlworkshop/schemanaut';

try {
  await runtime.generate({ question: '' });
} catch (error) {
  if (error instanceof DatabaseAgentError) {
    console.error(error.code, error.retryable, error.message, error.detail);
  }
}
```

Database-runtime failures use `DatabaseAccessRuntimeError`; provider failures use `LlmProviderError`.

## 13. Secret and deployment rules

- Read credentials from environment variables or your secret manager.
- Do not serialize credentials into connection profiles, resources, session messages, audit events, or logs.
- Keep the current local server on loopback. It is not a hardened multi-tenant gateway.
- Pair Agent modes with least-privilege database accounts.
- Inspect `toolExecutions`, database audit events, and metrics in applications that execute changes.
- Call `close()` before process shutdown to release database and SQLite handles.

## 14. Next references

- [Complete SDK API Reference](api-reference.md)
- [REST API overview](../../README.md#public-surfaces)
- [AI SQL design](../ai-sql/README.md)
- [Database access engineering design](../foundation/02-database-access.md)
- [Public contracts](../foundation/04-public-types-and-contracts.md)
