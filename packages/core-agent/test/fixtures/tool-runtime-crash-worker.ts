import { createRequire } from 'node:module';
import type { DatabaseSync as NodeDatabaseSync } from 'node:sqlite';
import {
  PermissionManager,
  SqliteAgentJournal,
  ToolRegistry,
} from '../../src/index.js';
import { preparedToolIntent } from '../permission-audit-fixture.js';
import {
  ToolInvocationRuntime,
  type ToolInvocationCrashPoint,
} from '../../src/tools/tool-invocation-runtime.js';

type CrashInput = {
  journalPath: string;
  counterPath: string;
  projectId: string;
  sessionId: string;
  runId: string;
  turnId: string;
  invocationId: string;
  lease: {
    projectId: string;
    runId: string;
    ownerId: string;
    fencingToken: number;
    expiresAt: string;
  };
  recoveryClass: 'read' | 'idempotent' | 'transactional' | 'non_idempotent';
  cut: ToolInvocationCrashPoint;
};

const encodedInput = process.env.DBAGENT_TOOL_CRASH_INPUT;
if (encodedInput === undefined) throw new Error('DBAGENT_TOOL_CRASH_INPUT is required.');
const input = JSON.parse(encodedInput) as CrashInput;
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => NodeDatabaseSync;
};

const journal = new SqliteAgentJournal({ filePath: input.journalPath });
const registry = new ToolRegistry();
registry.registerInvocation({
  name: 'query_database',
  description: 'persistent counter fixture',
  dangerLevel: 'safe',
  readonly: input.recoveryClass === 'read',
  source: 'unknown',
  access: input.recoveryClass === 'read' ? 'read' : 'write',
  recoveryClass: input.recoveryClass,
  toolRevision: 'query_database@1',
  handlerRevision: 'query_database-handler@1',
  intentRevision: 'prepared-tool-intent.v1',
  permission: { actions: ['read'] },
  exposure: 'direct',
  limits: { timeoutMs: 10_000, maxInputBytes: 4_096, maxOutputBytes: 65_536, maxArtifactBytes: 1_048_576, maxDepth: 8, maxRecords: 128 },
  outputSchema: { type: 'object' },
  failurePolicy: { onUnknown: { failureKind: 'unknown', retryable: false } },
  execution: { concurrency: input.recoveryClass === 'read' ? 'read' : 'write', timeoutMs: 10_000 },
  inputSchema: {
    type: 'object',
    properties: { sql: { type: 'string' } },
    required: ['sql'],
  },
}, {
  revision: { toolName: 'query_database', toolRevision: 'query_database@1', handlerRevision: 'query_database-handler@1', intentRevision: 'prepared-tool-intent.v1' },
  prepare: (preparedInput, context) => ({
    ...preparedToolIntent({ toolName: 'query_database', toolRevision: 'query_database@1', handlerRevision: 'query_database-handler@1', recoveryClass: input.recoveryClass }).intent,
    input: structuredClone(preparedInput), toolRevision: context.toolRevision,
    handlerRevision: context.handlerRevision, intentRevision: context.intentRevision,
    generation: context.generation, limits: context.limits,
  }),
  execute: (_prepared, context) => {
    const database = new DatabaseSync(input.counterPath);
    try {
      if (input.recoveryClass === 'idempotent') {
        database.prepare('INSERT OR IGNORE INTO effects (idempotency_key) VALUES (?)')
          .run(context.idempotencyKey);
      } else {
        database.prepare('INSERT INTO effects (idempotency_key) VALUES (?)')
          .run(`${context.idempotencyKey}:${crypto.randomUUID()}`);
      }
      const count = Number(
        (database.prepare('SELECT COUNT(*) AS count FROM effects').get() as { count: number }).count,
      );
      return { counter: count };
    } finally {
      database.close();
    }
  },
});
registry.registerInvocation({
  name: 'read_result',
  description: 'unused fixture Tool',
  dangerLevel: 'safe',
  readonly: true,
  source: 'unknown', access: 'read', recoveryClass: 'read',
  toolRevision: 'read_result@1', handlerRevision: 'read_result-handler@1', intentRevision: 'prepared-tool-intent.v1',
  permission: { actions: ['read'] },
  exposure: 'direct',
  limits: { timeoutMs: 10_000, maxInputBytes: 4_096, maxOutputBytes: 65_536, maxArtifactBytes: 1_048_576, maxDepth: 8, maxRecords: 128 },
  outputSchema: { type: 'object' }, failurePolicy: { onUnknown: { failureKind: 'unknown', retryable: false } },
  execution: { concurrency: 'read', timeoutMs: 10_000 },
  inputSchema: {
    type: 'object',
    properties: { resultRef: { type: 'string' } },
    required: ['resultRef'],
  },
}, {
  revision: { toolName: 'read_result', toolRevision: 'read_result@1', handlerRevision: 'read_result-handler@1', intentRevision: 'prepared-tool-intent.v1' },
  prepare: () => preparedToolIntent({ toolName: 'read_result', toolRevision: 'read_result@1', handlerRevision: 'read_result-handler@1' }).intent,
  execute: () => ({ skipped: true }),
});

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
  revalidateTarget: () => undefined,
  permissionManager: new PermissionManager(),
  binding: {
    projectId: input.projectId,
    sessionId: input.sessionId,
    runId: input.runId,
    turnId: input.turnId,
    lease: input.lease,
    mode: 'full-access',
  },
  onCrashPoint: (point) => {
    if (point === input.cut) process.exit(86);
  },
});

await runtime.execute(input.invocationId);
