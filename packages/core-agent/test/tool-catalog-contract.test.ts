import { describe, expect, it } from 'vitest';
import { BASE_TOOL_MANIFEST, ToolRegistry, overlayToolCatalogSnapshot } from '../src/index.js';
import { normalizeAgentToolResult } from '../src/tool-result.js';
import { invocationContribution } from './fixtures/invocation-contribution.js';

describe('tool catalog contract', () => {
  it('publishes the immutable 14-Tool Runtime baseline in consumption order', () => {
    expect(BASE_TOOL_MANIFEST).toEqual([
      { name: 'ask_user', schemaRevision: 'ask_user.v1' },
      { name: 'tool_search', schemaRevision: 'tool_search.v1' },
      { name: 'result_read', schemaRevision: 'result_read.v1' },
      { name: 'result_materialize', schemaRevision: 'result_materialize.v1' },
      { name: 'result_save', schemaRevision: 'result_save.v1' },
      { name: 'skill', schemaRevision: 'skill.v1' },
      { name: 'workspace_list', schemaRevision: 'workspace_list.v1' },
      { name: 'workspace_read', schemaRevision: 'workspace_read.v1' },
      { name: 'workspace_search', schemaRevision: 'workspace_search.v1' },
      { name: 'workspace_apply_patch', schemaRevision: 'workspace_apply_patch.v1' },
      { name: 'process_exec', schemaRevision: 'process_exec.v1' },
      { name: 'process_control', schemaRevision: 'process_control.v1' },
      { name: 'web_search', schemaRevision: 'web_search.v1' },
      { name: 'web_fetch', schemaRevision: 'web_fetch.v1' },
    ]);
  });

  it('keeps Run-private Tool overlays isolated without mutating the shared catalog', () => {
    const registry = new ToolRegistry();
    const base = registry.captureSnapshot();
    const first = overlayToolCatalogSnapshot(base, invocationContribution('run_skill', { marker: 'first' }, {
      exposure: 'direct', toolRevision: 'run_skill@1', handlerRevision: 'run-skill-first@1',
    }));
    const secondBase = registry.captureSnapshot();
    const second = overlayToolCatalogSnapshot(secondBase, invocationContribution('run_skill', { marker: 'second' }, {
      exposure: 'direct', toolRevision: 'run_skill@1', handlerRevision: 'run-skill-second@1',
    }));
    try {
      expect(registry.listDescriptors()).toEqual([]);
      expect(first.get('run_skill')?.descriptor.handlerRevision).toBe('run-skill-first@1');
      expect(second.get('run_skill')?.descriptor.handlerRevision).toBe('run-skill-second@1');
    } finally {
      first.release();
      second.release();
    }
  });

  it('separates immutable descriptors from executable runtimes and versions every mutation', () => {
    const registry = new ToolRegistry();
    registry.registerInvocation(
      invocationContribution('query_events', { eventType: 'page_view' }, {
        exposure: 'deferred', toolRevision: 'query_events@1', handlerRevision: 'query-events-handler@1',
      }).definition,
      invocationContribution('query_events', { eventType: 'page_view' }, {
        exposure: 'deferred', toolRevision: 'query_events@1', handlerRevision: 'query-events-handler@1',
      }).runtime,
    );
    const descriptor = registry.get('query_events')?.descriptor;
    expect(descriptor).toMatchObject({
      flatName: 'query_events', exposure: 'deferred', access: 'read', recoveryClass: 'read',
      toolRevision: 'query_events@1', handlerRevision: 'query-events-handler@1',
      execution: { concurrency: 'read', timeoutMs: 1_000 },
    });
    expect(registry.unregister('query_events')).toBe(true);
    expect(registry.catalogRevision).toBe(2);
  });

  it('rejects the removed private envelope at the Runtime result boundary', () => {
    expect(() => normalizeAgentToolResult({
      type: 'schemanaut.agent-tool-result.v1', modelProjection: { rows: [] }, durableSummary: { rowCount: 0 },
    }, {
      outputSchema: { type: 'object' },
      limits: { timeoutMs: 1_000, maxInputBytes: 4_096, maxOutputBytes: 65_536, maxArtifactBytes: 1_048_576, maxDepth: 8, maxRecords: 128 },
      provenance: {
        issuer: 'runtime', hostId: 'host', sessionId: 'session', runId: 'run',
        invocationId: 'invocation', toolName: 'query_events', toolRevision: 'query_events@1',
        handlerRevision: 'query-events-handler@1', intentRevision: 'prepared-tool-intent.v1',
        source: 'fixture', generation: 'fixture@1',
      },
    })).toThrow(/result/i);
  });

  it('fits an automatic Artifact observation inside the minimum projection budget', () => {
    const normalized = normalizeAgentToolResult({
      status: 'ok', summary: 'large result', output: 'x'.repeat(70_000),
    }, {
      outputSchema: { type: 'object' },
      limits: { timeoutMs: 1_000, maxInputBytes: 4_096, maxOutputBytes: 65_536, maxArtifactBytes: 1_048_576, maxDepth: 8, maxRecords: 128 },
      projectionBudget: { maxTokens: 1_024, estimateTokens: text => Buffer.byteLength(text, 'utf8') },
      provenance: {
        issuer: 'runtime', hostId: 'host', sessionId: 'session', runId: 'run',
        invocationId: 'invocation', toolName: 'query_events', toolRevision: 'query_events@1',
        handlerRevision: 'query-events-handler@1', intentRevision: 'prepared-tool-intent.v1',
        source: 'fixture', generation: 'fixture@1',
      },
    });
    expect(normalized.artifactBytes?.byteLength).toBeGreaterThan(65_536);
    expect(Buffer.byteLength(normalized.preview, 'utf8')).toBeLessThan(1_024);
  });
});
