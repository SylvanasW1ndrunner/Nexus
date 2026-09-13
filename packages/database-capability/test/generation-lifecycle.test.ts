import { describe, expect, it } from 'vitest';
import { SchemaRagEngine } from '@dbagent/core-rag';
import {
  createDatabaseToolGeneration,
  type ActiveDatabaseBinding,
  type SchemaRagReadView,
} from '../src/index.js';

describe('database Capability Tool generations', () => {

  it('keeps old and new connection fingerprints in separately prepared Tool generations', async () => {
    const oldGeneration = createDatabaseToolGeneration({ binding: binding('connection-old', 'profile-old'), queryExecutor: () => Promise.resolve(queryResult()) });
    const newGeneration = createDatabaseToolGeneration({ binding: binding('connection-new', 'profile-new'), queryExecutor: () => Promise.resolve(queryResult()) });
    expect((await sqlIntent(oldGeneration)).targetIdentity).toMatchObject({ connectionId: 'connection-old', profileId: 'profile-old' });
    expect((await sqlIntent(newGeneration)).targetIdentity).toMatchObject({ connectionId: 'connection-new', profileId: 'profile-new' });
  });
});

function binding(connectionId: string, profileId: string): ActiveDatabaseBinding {
  const rag = new SchemaRagEngine();
  const view: SchemaRagReadView = {
    connectionId,
    getCatalog: () => rag.getCatalog(connectionId),
    listResources: (input) => rag.listResources({ connectionId, ...input }),
    getResource: (input) => rag.getResource({ connectionId, ...input }),
    searchAsync: (input) => rag.searchAsync({ connectionId, ...input }),
  };
  return { connectionId, profileId, host: 'database.example.test', readOnly: false, schema: view };
}
function queryResult() { return { queryId: 'query', columns: [], rows: [], rowCount: 0, elapsedMs: 1, safety: { statementKind: 'SELECT', riskLevel: 'safe' as const, requiresConfirmation: false, blocked: false, reasons: [] } }; }
function sqlIntent(generation: ReturnType<typeof createDatabaseToolGeneration>) {
  const contribution = generation.contributions.find(({ definition }) => definition.name === 'sql_execute');
  if (!contribution) throw new Error('sql_execute is required.');
  return contribution.runtime.prepare({ sql: 'SELECT 1' }, {
    projectId: 'project', sessionId: 'session', runId: 'run', turnId: 'turn', invocationId: 'invocation', idempotencyKey: 'key',
    hostId: 'host', generation: 'generation@1', descriptor: contribution.definition as never,
    runPolicy: { mode: 'full-access', revision: 'test-run-policy.v1' },
    toolRevision: contribution.definition.toolRevision, handlerRevision: contribution.definition.handlerRevision,
    intentRevision: 'prepared-tool-intent.v1', limits: contribution.definition.limits,
    discoverableTools: [], discoverableCapabilities: [], signal: new AbortController().signal,
  });
}
