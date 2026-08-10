import { createRequire } from 'node:module';
import type { DatabaseSync as NodeDatabaseSync } from 'node:sqlite';
import {
  PermissionManager,
  SqliteAgentJournal,
  ToolRegistry,
  createAgentToolResultEnvelope,
} from '../../src/index.js';
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
  effect: 'read' | 'idempotent' | 'transactional' | 'non_idempotent';
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
  readonly: input.effect === 'read',
  effect: input.effect,
  handlerRevision: 'query_database@1',
  requiredPermission: 'read',
  exposure: 'direct',
  execution: { concurrency: input.effect === 'read' ? 'read' : 'write', timeoutMs: 10_000 },
  inputSchema: {
    type: 'object',
    properties: { sql: { type: 'string' } },
    required: ['sql'],
  },
}, {
  execute: (_arguments, context) => {
    const database = new DatabaseSync(input.counterPath);
    try {
      if (input.effect === 'idempotent') {
        database.prepare('INSERT OR IGNORE INTO effects (idempotency_key) VALUES (?)')
          .run(context.idempotencyKey);
      } else {
        database.prepare('INSERT INTO effects (idempotency_key) VALUES (?)')
          .run(`${context.idempotencyKey}:${crypto.randomUUID()}`);
      }
      const count = Number(
        (database.prepare('SELECT COUNT(*) AS count FROM effects').get() as { count: number }).count,
      );
      return createAgentToolResultEnvelope({
        modelProjection: { counter: count },
        durableSummary: { counter: count },
      });
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
  effect: 'read',
  handlerRevision: 'read_result@1',
  requiredPermission: 'read',
  exposure: 'direct',
  execution: { concurrency: 'read' },
  inputSchema: {
    type: 'object',
    properties: { resultRef: { type: 'string' } },
    required: ['resultRef'],
  },
}, {
  execute: () => createAgentToolResultEnvelope({
    modelProjection: { skipped: true }, durableSummary: { skipped: true },
  }),
});

const runtime = new ToolInvocationRuntime({
  journal,
  registry: registry.captureSnapshot(),
  permissionManager: new PermissionManager(),
  binding: {
    projectId: input.projectId,
    sessionId: input.sessionId,
    runId: input.runId,
    turnId: input.turnId,
    lease: input.lease,
    mode: 'full',
  },
  onCrashPoint: (point) => {
    if (point === input.cut) process.exit(86);
  },
});

await runtime.execute(input.invocationId);
