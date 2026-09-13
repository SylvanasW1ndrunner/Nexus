import { describe, expect, it } from 'vitest';
import type { ContentReadResult, ToolExecuteContext } from '@dbagent/core-agent';
import { createResultReadToolContribution } from '../src/result-tools.js';

describe('result_read tool', () => {
  it('prepares an unbounded record read with the model-safe default of 40 items', () => {
    const contribution = createResultReadToolContribution({});
    const contentRef = 'schemanaut-content:v1:artifact_' + 'a'.repeat(64) + ':' + 'b'.repeat(64);
    const prepared = contribution.runtime.prepare({ contentRef, mode: 'record' }, {
      toolRevision: contribution.definition.toolRevision,
      handlerRevision: contribution.definition.handlerRevision,
      generation: 'test-generation',
      limits: contribution.definition.limits,
    } as never);
    if (prepared instanceof Promise) throw new Error('result_read prepare must be synchronous.');
    expect(prepared.input).toEqual({ contentRef, mode: 'record', limit: 40, offset: 0 });
  });

  it('projects one authoritative navigable data page without duplicating the Store preview', async () => {
    const page: ContentReadResult = {
      contentRef: 'schemanaut-content:v1:artifact_' + 'a'.repeat(64) + ':' + 'b'.repeat(64),
      mode: 'record',
      contentType: 'application/json',
      totalBytes: 8_192,
      offset: 0,
      preview: '[{"row":{"id":1}}]',
      data: [{ row: { id: 1 } }],
      nextCursor: `schemanaut-cursor:v2:record:1:${'c'.repeat(64)}`,
      eof: false,
    };
    const contribution = createResultReadToolContribution({
      artifactStore: { readContent: () => Promise.resolve(page) },
    });

    const result = await contribution.runtime.execute({
      contentRef: page.contentRef,
      mode: 'record',
      limit: 40,
      offset: 0,
    }, {
      hostId: 'host', projectId: 'project', sessionId: 'session', runId: 'run',
      turnId: 'turn', invocationId: 'invocation', idempotencyKey: 'key',
      fencingToken: 1, deadline: '2100-01-01T00:00:00.000Z',
      authorization: {}, discoverableTools: [], discoverableCapabilities: [],
      reportProgress: () => undefined, signal: new AbortController().signal,
      intent: {},
    } as unknown as ToolExecuteContext);

    expect(contribution.definition.handlerRevision).toBe('result_read.handler.v3');
    expect(result).toEqual({
      status: 'ok',
      summary: `Runtime content page read. Continue with nextCursor: ${page.nextCursor}.`,
      contentRef: page.contentRef,
      mode: page.mode,
      contentType: page.contentType,
      totalBytes: page.totalBytes,
      offset: page.offset,
      eof: false,
      nextCursor: page.nextCursor,
      data: page.data,
    });
    expect(Object.keys(result as object)).toEqual([
      'status', 'summary', 'contentRef', 'mode', 'contentType', 'totalBytes',
      'offset', 'eof', 'nextCursor', 'data',
    ]);
    expect(result).not.toHaveProperty('preview');
  });
});
