import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { ToolRegistry } from '@dbagent/core-agent';
import { DatabaseAccessRuntimeError } from '@dbagent/core-db';
import { SchemaRagEngine } from '@dbagent/core-rag';
import { assertPortableValue } from '@dbagent/shared';
import { createAiSqlToolContributions, type ActiveDatabaseBinding } from '../src/index.js';
import { executeAiSqlInvocations } from './ai-sql-invocation-test-harness.js';

describe('AI SQL prepared Tool contributions', () => {
  it.each([
    { name: 'resource_list', arguments: { scope: 'commerce.missing_orders' } },
    { name: 'resource_get', arguments: { resource: 'commerce.missing_orders' } },
  ])('classifies an unresolved $name reference as invalid input after one schema refresh', async (call) => {
    let schemaRefreshes = 0;
    const activeBinding = binding();
    const contributions = createAiSqlToolContributions({
      binding: activeBinding,
      ensureSchemaFresh: () => {
        schemaRefreshes += 1;
        return Promise.resolve(activeBinding);
      },
      queryExecutor: () => Promise.resolve(queryResult()),
    }).contributions;
    const registry = new ToolRegistry();
    for (const contribution of contributions) registry.registerInvocation(contribution.definition, contribution.runtime);

    const invocation = await executeAiSqlInvocations(registry, [call], { mode: 'full-access' });
    try {
      expect(invocation.observations).toMatchObject([
        { outcome: 'failed', errorCode: 'TOOL_INPUT_INVALID' },
      ]);
      expect(invocation.observations[0]?.summary).toContain('Database resource is not available: commerce.missing_orders');
      expect(schemaRefreshes).toBe(1);
    } finally {
      await invocation.dispose();
    }
  });

  it('invokes database actions through an activated Capability Tool and ordinary payload', async () => {
    const executed: string[] = [];
    const contributions = createAiSqlToolContributions({
      binding: binding(), queryExecutor: (input) => {
        executed.push(input.binding.profileId);
        return Promise.resolve(queryResult());
      },
    }).contributions;
    expect(contributions).toHaveLength(5);
    for (const { definition, runtime } of contributions) {
      expect(definition.exposure).toBe('direct');
      expect(typeof definition.access).toBe('string');
      expect(typeof definition.recoveryClass).toBe('string');
      expect(typeof definition.limits).toBe('object');
      expect(typeof definition.outputSchema).toBe('object');
      expect(typeof runtime.revision).toBe('object');
      expect(typeof runtime.prepare).toBe('function');
      expect(typeof runtime.execute).toBe('function');
    }
    const registry = new ToolRegistry();
    for (const contribution of contributions) registry.registerInvocation(contribution.definition, contribution.runtime);
    const invocation = await executeAiSqlInvocations(registry, [{ name: 'sql_execute', arguments: { sql: 'SELECT 1' } }], { mode: 'full-access' });
    try {
      expect(invocation.observations).toMatchObject([{ outcome: 'succeeded' }]);
      expect(executed).toEqual(['profile-1']);
    } finally {
      await invocation.dispose();
    }
  });

  it('maps a definite SQL validation rejection to invalid input without requesting user resolution', async () => {
    const contributions = createAiSqlToolContributions({
      binding: binding(),
      queryExecutor: () => Promise.reject(new DatabaseAccessRuntimeError({
        code: 'VALIDATION_ERROR', category: 'validation',
        message: 'PostgreSQL rejected invalid SQL.',
        detail: 'column "missing_column" does not exist',
        stage: 'execute', profileId: 'profile-1', jobId: 'query-1',
        retryable: false, outcome: 'unchanged',
      })),
    }).contributions;
    const registry = new ToolRegistry();
    for (const contribution of contributions) registry.registerInvocation(contribution.definition, contribution.runtime);

    const invocation = await executeAiSqlInvocations(
      registry,
      [{ name: 'sql_execute', arguments: { sql: 'SELECT missing_column FROM orders' } }],
      { mode: 'full-access' },
    );
    try {
      expect(invocation.observations).toMatchObject([
        { outcome: 'failed', errorCode: 'TOOL_INPUT_INVALID' },
      ]);
      expect(invocation.invocations).toMatchObject([{
        terminal: {
          kind: 'failed',
          error: { code: 'TOOL_INPUT_INVALID', outcome: 'not_applied' },
        },
      }]);
      expect(invocation.approvals).toHaveLength(0);
    } finally {
      await invocation.dispose();
    }
  });

  it('prepares a SQL invocation with a fingerprinted database target and bounded limits', () => {
    const contribution = createAiSqlToolContributions({
      binding: binding(), queryExecutor: () => Promise.resolve(queryResult()),
    }).contributions.find(({ definition }) => definition.name === 'sql_execute');
    if (!contribution) throw new Error('sql_execute contribution is required.');
    const intent = contribution.runtime.prepare({ sql: 'SELECT 1' }, {
      projectId: 'project', sessionId: 'session', runId: 'run', turnId: 'turn', invocationId: 'invocation', idempotencyKey: 'key',
      hostId: 'host', generation: 'database-generation@1', descriptor: contribution.definition as never,
      runPolicy: { mode: 'full-access', revision: 'test-run-policy.v1' },
      toolRevision: contribution.definition.toolRevision, handlerRevision: contribution.definition.handlerRevision,
      intentRevision: 'prepared-tool-intent.v1', limits: contribution.definition.limits,
      discoverableTools: [], discoverableCapabilities: [], signal: new AbortController().signal,
    });
    if (intent instanceof Promise) throw new Error('SQL prepare must be synchronous.');
    expect(intent).toMatchObject({ access: 'external', recoveryClass: 'read', targetIdentity: { connectionId: 'connection-1' } });
    expect(typeof intent.limits.timeoutMs).toBe('number');
  });

  it('projects nested Date values to UTC ISO strings before an unzoned sql_execute result reaches the Runtime', async () => {
    const topLevel = new Date('2026-09-10T01:02:03.004Z');
    const nested = new Date('2026-09-10T05:06:07.008Z');
    const arrayItem = new Date('2026-09-10T09:10:11.012Z');
    const result = {
      ...queryResult(),
      rows: [{
        topLevel,
        nested: { occurredAt: nested },
        history: [arrayItem],
      }],
      rowCount: 1,
      returnedRowCount: 1,
    };
    const contributions = createAiSqlToolContributions({
      binding: binding(),
      queryExecutor: () => Promise.resolve(result),
    }).contributions;
    const contribution = contributions.find(({ definition }) => definition.name === 'sql_execute');
    if (!contribution) throw new Error('sql_execute contribution is required.');

    const payload = await contribution.runtime.execute({ sql: 'SELECT recorded_at' }, {
      authorization: {
        policyMode: 'full-access', policyDecision: 'allow', policyRevision: 'test',
        permission: { actions: ['database-query'], network: true }, matchedRuleIds: [],
      },
      signal: new AbortController().signal,
    } as never);
    expect(payload).toMatchObject({
      rows: [{
        topLevel: topLevel.toISOString(),
        nested: { occurredAt: nested.toISOString() },
        history: [arrayItem.toISOString()],
      }],
    });
    expect(() => assertPortableValue(payload)).not.toThrow();

    const registry = new ToolRegistry();
    for (const item of contributions) registry.registerInvocation(item.definition, item.runtime);
    const invocation = await executeAiSqlInvocations(
      registry,
      [{ name: 'sql_execute', arguments: { sql: 'SELECT recorded_at' } }],
      { mode: 'full-access' },
    );
    try {
      expect(invocation.observations).toMatchObject([{ outcome: 'succeeded' }]);
    } finally {
      await invocation.dispose();
    }
  });

  it('stores a large query result behind a Runtime content reference instead of projecting every row', async () => {
    const registry = new ToolRegistry();
    const result = { ...queryResult(), rows: Array.from({ length: 250 }, (_, id) => ({ id })), rowCount: 250, returnedRowCount: 250 };
    const contributions = createAiSqlToolContributions({
      binding: binding(),
      queryExecutor: () => Promise.resolve({ result, handle: {
        id: 'durable-result', jobId: 'query', format: 'rows', columns: [], rowCount: 250, hasMore: false, truncated: false,
        schemaVersion: 1, scheme: 'schemanaut.database-result', projectId: 'project-ai-sql', checksum: 'sha256:durable-result', availability: 'available', createdAt: '2026-09-10T00:00:00.000Z',
      } }),
      resultContent: ({ resultId }) => Promise.resolve({
        mediaType: 'application/x-ndjson',
        identity: resultId,
        source: resultRows(result.rows),
      }),
    }).contributions;
    for (const contribution of contributions) registry.registerInvocation(contribution.definition, contribution.runtime);
    const invocation = await executeAiSqlInvocations(registry, [{ name: 'sql_execute', arguments: { sql: 'SELECT * FROM orders' } }], { mode: 'full-access' });
    try {
      expect(invocation.observations).toHaveLength(1);
      const observation = invocation.observations[0]!;
      expect(observation).toMatchObject({
        outcome: 'succeeded',
      });
      expect(observation.evidenceRefs).toHaveLength(1);
      expect(observation.evidenceRefs[0]).toMatch(/^schemanaut-evidence:v1:/u);
      expect(JSON.stringify(invocation.observations)).not.toContain('"id":249');
      const projection = observation.modelProjection;
      if (
        projection === undefined || projection === null || typeof projection !== 'object' ||
        Array.isArray(projection) || !('contentRef' in projection) ||
        typeof projection.contentRef !== 'string'
      ) throw new Error('Runtime contentRef is required.');
      const page = await invocation.artifactStore.readContent({
        contentRef: projection.contentRef,
        access: {
          hostId: 'local',
          projectId: invocation.projectId,
          sessionId: invocation.sessionId,
          runId: invocation.runId,
        },
        mode: 'record',
        limit: 1_000,
      });
      expect(JSON.stringify(page.data)).toContain('"id":249');
    } finally {
      await invocation.dispose();
    }
  });
});

function resultRows(rows: readonly Readonly<Record<string, unknown>>[]): AsyncIterable<Uint8Array> {
  const encoder = new TextEncoder();
  return Readable.from([
    encoder.encode(`${JSON.stringify({ type: 'database-result' })}\n`),
    ...rows.map((row) => encoder.encode(`${JSON.stringify({ type: 'row', row })}\n`)),
  ]);
}

function binding(): ActiveDatabaseBinding {
  const rag = new SchemaRagEngine();
  rag.index({ connectionId: 'connection-1', resources: [] });
  return { connectionId: 'connection-1', profileId: 'profile-1', host: 'database.example.test', readOnly: false, schema: {
    connectionId: 'connection-1', getCatalog: () => rag.getCatalog('connection-1'),
    listResources: (input) => rag.listResources({ connectionId: 'connection-1', ...input }),
    getResource: (input) => rag.getResource({ connectionId: 'connection-1', ...input }),
    searchAsync: (input) => rag.searchAsync({ connectionId: 'connection-1', ...input }),
  } };
}

function queryResult() {
  return { queryId: 'query', columns: [], rows: [], rowCount: 0, returnedRowCount: 0, elapsedMs: 1,
    safety: { statementKind: 'SELECT', riskLevel: 'safe' as const, requiresConfirmation: false, blocked: false, reasons: [] } };
}
