import { randomUUID } from 'node:crypto';
import { access, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { DatabaseSync as NodeDatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import {
  PermissionManager,
  SqliteAgentJournal,
  ToolRegistry,
  createAgentToolResultEnvelope,
} from '../../src/index.js';
import { ToolInvocationRuntime } from '../../src/tools/tool-invocation-runtime.js';

type RecoveryRaceInput = {
  journalPath: string;
  counterPath: string;
  readyPath: string;
  releasePath: string;
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
  effect: 'read' | 'idempotent' | 'transactional';
};

const encodedInput = process.env.DBAGENT_TOOL_RECOVERY_RACE_INPUT;
if (encodedInput === undefined) throw new Error('DBAGENT_TOOL_RECOVERY_RACE_INPUT is required.');
const input = JSON.parse(encodedInput) as RecoveryRaceInput;
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => NodeDatabaseSync;
};

const handler = async (_arguments: Readonly<Record<string, unknown>>, context: {
  idempotencyKey: string;
}) => {
  const database = new DatabaseSync(input.counterPath);
  try {
    database.prepare('INSERT INTO handler_calls (call_id) VALUES (?)').run(randomUUID());
    if (input.effect === 'idempotent') {
      database.prepare('INSERT OR IGNORE INTO effects (idempotency_key) VALUES (?)')
        .run(context.idempotencyKey);
    } else {
      database.prepare('INSERT INTO effects (idempotency_key) VALUES (?)')
        .run(`${context.idempotencyKey}:${randomUUID()}`);
    }
    await delay(75);
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
};

const journal = new SqliteAgentJournal({ filePath: input.journalPath });
const registry = new ToolRegistry();
registry.registerInvocation({
  name: 'query_database', description: 'persistent counter fixture', dangerLevel: 'safe',
  readonly: input.effect === 'read', effect: input.effect,
  handlerRevision: 'query_database@1', requiredPermission: 'read', exposure: 'direct',
  execution: { concurrency: input.effect === 'read' ? 'read' : 'write', timeoutMs: 10_000 },
  inputSchema: {
    type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'],
  },
}, {
  execute: handler,
  ...(input.effect === 'transactional' ? { recover: handler } : {}),
});
registry.registerInvocation({
  name: 'read_result', description: 'unused fixture Tool', dangerLevel: 'safe', readonly: true,
  effect: 'read', handlerRevision: 'read_result@1', requiredPermission: 'read',
  exposure: 'direct', execution: { concurrency: 'read' },
  inputSchema: {
    type: 'object', properties: { resultRef: { type: 'string' } }, required: ['resultRef'],
  },
}, {
  execute: () => createAgentToolResultEnvelope({
    modelProjection: { skipped: true }, durableSummary: { skipped: true },
  }),
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
});
await runtime.recover(input.invocationId);
