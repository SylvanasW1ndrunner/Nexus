import { randomUUID } from 'node:crypto';
import { access, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { DatabaseSync as NodeDatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import {
  PermissionManager,
  SqliteAgentJournal,
  ToolRegistry,
} from '../../src/index.js';
import { preparedToolIntent } from '../permission-audit-fixture.js';
import { ToolInvocationRuntime } from '../../src/tools/tool-invocation-runtime.js';

type ParallelWindowInput = Readonly<{
  journalPath: string;
  counterPath: string;
  readyPath: string;
  releasePath: string;
  projectId: string;
  sessionId: string;
  runId: string;
  turnId: string;
  lease: Readonly<{
    projectId: string;
    runId: string;
    ownerId: string;
    fencingToken: number;
    expiresAt: string;
  }>;
}>;

const encoded = process.env.DBAGENT_TOOL_PARALLEL_WINDOW_INPUT;
if (encoded === undefined) throw new Error('DBAGENT_TOOL_PARALLEL_WINDOW_INPUT is required.');
const input = JSON.parse(encoded) as ParallelWindowInput;
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => NodeDatabaseSync;
};

const registry = new ToolRegistry();
registry.registerInvocation({
  name: 'query_database', description: 'parallel process read fixture', dangerLevel: 'safe',
  readonly: true, source: 'unknown', access: 'read', recoveryClass: 'read',
  toolRevision: 'query_database@1', handlerRevision: 'query_database@parallel-window-1',
  intentRevision: 'prepared-tool-intent.v1',
  permission: { actions: ['read'] }, exposure: 'direct',
  limits: { timeoutMs: 10_000, maxInputBytes: 4_096, maxOutputBytes: 65_536, maxArtifactBytes: 1_048_576, maxDepth: 8, maxRecords: 128 },
  outputSchema: { type: 'object' }, failurePolicy: { onUnknown: { failureKind: 'unknown', retryable: false } },
  execution: { concurrency: 'read', timeoutMs: 10_000 },
  inputSchema: {
    type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'],
  },
}, {
  revision: { toolName: 'query_database', toolRevision: 'query_database@1', handlerRevision: 'query_database@parallel-window-1', intentRevision: 'prepared-tool-intent.v1' },
  prepare: (preparedInput, context) => ({
    ...preparedToolIntent({ toolName: 'query_database', toolRevision: 'query_database@1', handlerRevision: 'query_database@parallel-window-1' }).intent,
    input: structuredClone(preparedInput),
    toolRevision: context.toolRevision,
    handlerRevision: context.handlerRevision,
    intentRevision: context.intentRevision,
    generation: context.generation,
    targetIdentity: null,
    limits: context.limits,
  }),
  execute: async (prepared, context) => {
    const preparedInput = prepared as { sql: string };
    const database = new DatabaseSync(input.counterPath);
    try {
      database.exec('PRAGMA busy_timeout=5000');
      database.prepare(
        'INSERT INTO parallel_handler_calls (call_id, invocation_id) VALUES (?, ?)',
      ).run(randomUUID(), context.invocationId);
    } finally {
      database.close();
    }
    await delay(preparedInput.sql === 'slow' ? 75 : 15);
    return { sql: preparedInput.sql };
  },
});

await writeFile(input.readyPath, 'ready', 'utf8');
for (;;) {
  try {
    await access(input.releasePath);
    break;
  } catch {
    await delay(5);
  }
}

const journal = new SqliteAgentJournal({ filePath: input.journalPath });
const snapshot = registry.captureSnapshot();
const allowedTools = snapshot.llmTools().map(({ name }) => {
  const revision = snapshot.invocationRevision(name);
  if (revision === undefined) throw new Error(`Missing Invocation revision for ${name}.`);
  return { name, revision };
});
const runtime = new ToolInvocationRuntime({
  journal,
  registry: snapshot,
  allowedTools,
  permissionManager: new PermissionManager(),
  binding: {
    projectId: input.projectId,
    sessionId: input.sessionId,
    runId: input.runId,
    turnId: input.turnId,
    lease: input.lease,
    mode: 'full-access',
  },
  maxConcurrency: 2,
});
await runtime.resolve();
await runtime.executeEligible();
