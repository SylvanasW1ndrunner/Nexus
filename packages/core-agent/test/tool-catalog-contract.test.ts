import { describe, expect, it, vi } from 'vitest';
import {
  ToolRegistry,
  createAgentToolResultEnvelope,
  readAgentToolResultEnvelope,
} from '../src/index.js';

describe('tool catalog contract', () => {
  it('separates structured descriptors from executable runtimes and versions every mutation', async () => {
    const registry = new ToolRegistry();
    const onChange = vi.fn();
    const unsubscribe = registry.subscribe(onChange);

    registry.register(
      {
        namespace: 'postgres.analytics',
        name: 'query_events',
        title: '查询事件',
        description: 'Query event rows with filters',
        aliases: ['事件查询', 'filter events'],
        tags: ['database', 'analytics'],
        inputSchema: {
          type: 'object',
          properties: {
            eventType: { type: 'string', description: '事件类型 event type' },
          },
        },
        outputSchema: { type: 'object' },
        dangerLevel: 'safe',
        readonly: true,
        exposure: 'deferred',
        source: 'database',
      },
      (args) => ({ eventType: args.eventType }),
    );

    expect(registry.catalogRevision).toBe(1);
    expect(registry.listDescriptors()).toHaveLength(1);
    expect(registry.listDescriptors()[0]).toMatchObject({
      id: { namespace: 'postgres.analytics', name: 'query_events' },
      flatName: 'query_events',
      title: '查询事件',
      aliases: ['事件查询', 'filter events'],
      tags: ['database', 'analytics'],
      exposure: 'deferred',
      execution: { concurrency: 'read' },
    });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ revision: 1, kind: 'registered', toolName: 'query_events' }),
    );

    const runtime = registry.getRuntime({ namespace: 'postgres.analytics', name: 'query_events' });
    expect(runtime).toBeDefined();
    expect(
      await runtime?.handler(
        { eventType: 'page_view' },
        { session: minimalSession('catalog-session') },
      ),
    ).toEqual({ eventType: 'page_view' });

    expect(registry.unregister('query_events')).toBe(true);
    expect(registry.catalogRevision).toBe(2);
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ revision: 2, kind: 'unregistered', toolName: 'query_events' }),
    );

    unsubscribe();
  });

  it('keeps duplicate registration and missing removal from producing false catalog revisions', () => {
    const registry = new ToolRegistry();
    registry.register(toolDefinition('one'), () => undefined);

    expect(() => registry.register(toolDefinition('one'), () => undefined)).toThrow(
      'Tool already registered: one',
    );
    expect(registry.unregister('missing')).toBe(false);
    expect(registry.catalogRevision).toBe(1);
  });

  it('carries independent model, user, durable and audit projections without merging them', () => {
    const result = createAgentToolResultEnvelope({
      modelProjection: { rows: [{ id: 1 }] },
      userProjection: { previewRows: [{ id: 1 }, { id: 2 }], hasMore: true },
      durableSummary: { rowCount: 20_000 },
      auditEvidence: { status: 'success', durationMs: 13, resultType: 'tabular' },
      completionEvidence: { kind: 'database-result', deliveryReady: true, rowCount: 20_000 },
    });

    const projections = readAgentToolResultEnvelope(result);
    expect(projections.modelProjection).toEqual({ rows: [{ id: 1 }] });
    expect(projections.userProjection).toEqual({
      previewRows: [{ id: 1 }, { id: 2 }],
      hasMore: true,
    });
    expect(projections.durableSummary).toEqual({ rowCount: 20_000 });
    expect(projections.auditEvidence).toEqual({
      status: 'success',
      durationMs: 13,
      resultType: 'tabular',
    });
  });
});

function toolDefinition(name: string) {
  return {
    name,
    description: name,
    inputSchema: { type: 'object' },
    dangerLevel: 'safe' as const,
  };
}

function minimalSession(id: string) {
  return {
    id,
    title: id,
    mode: 'read' as const,
    messages: [],
    tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    aborted: false,
  };
}
