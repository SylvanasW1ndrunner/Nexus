import { describe, expect, it, vi } from 'vitest';
import type {
  ModelAttemptExecution,
  ModelSession,
  ModelSessionBundle,
} from '@dbagent/core-llm';
import {
  ContextLifecycle,
  decideContextLifecycle,
  readBoundedCommittedContext,
  readBoundedContextItems,
} from '../src/context/context-lifecycle.js';
import {
  PromptRuntime,
  type PromptSection,
} from '../src/context/prompt-runtime.js';

describe('Context lifecycle', () => {
  it.each([
    { label: 'below', estimated: 500, expected: { action: 'use-context', diagnostic: 'fits' } },
    {
      label: 'near', estimated: 699,
      expected: { action: 'use-context', diagnostic: 'near-limit' },
    },
    {
      label: 'equal', estimated: 700, expected: { action: 'use-context', diagnostic: 'near-limit' },
    },
    {
      label: 'above', estimated: 701, expected: { action: 'compact', reason: 'automatic' },
    },
  ])('uses the exact persisted input limit at the $label boundary', ({ estimated, expected }) => {
    expect(decideContextLifecycle({
      maxInputTokens: 1_000,
      estimatedInputTokens: estimated,
      outputReserveTokens: 200,
      protocolReserveTokens: 50,
      toolReserveTokens: 50,
      compactedForDecision: false,
      manualRequested: false,
      safeBoundary: true,
    })).toEqual({ ...expected, inputBudgetTokens: 700 });
  });

  it('keeps an unknown model input limit unknown instead of inventing 32K', () => {
    expect(decideContextLifecycle({
      maxInputTokens: null,
      estimatedInputTokens: 1_000_000,
      outputReserveTokens: 8_000,
      protocolReserveTokens: 1_000,
      toolReserveTokens: 1_000,
      compactedForDecision: false,
      manualRequested: false,
      safeBoundary: true,
    })).toEqual({ action: 'use-context', diagnostic: 'unknown-limit', inputBudgetTokens: null });
  });

  it('permits only one automatic compaction transaction per decision', () => {
    expect(decideContextLifecycle({
      maxInputTokens: 1_000,
      estimatedInputTokens: 900,
      outputReserveTokens: 200,
      protocolReserveTokens: 50,
      toolReserveTokens: 50,
      compactedForDecision: true,
      manualRequested: false,
      safeBoundary: true,
    })).toEqual({
      action: 'over-limit',
      code: 'CONTEXT_STILL_OVER_LIMIT',
      inputBudgetTokens: 700,
    });
  });

  it('queues manual compaction until a safe model/tool boundary', () => {
    const base = {
      maxInputTokens: 10_000,
      estimatedInputTokens: 100,
      outputReserveTokens: 500,
      protocolReserveTokens: 100,
      toolReserveTokens: 100,
      compactedForDecision: false,
      manualRequested: true,
    };
    expect(decideContextLifecycle({ ...base, safeBoundary: false })).toEqual({
      action: 'queue-manual-compaction', inputBudgetTokens: 9_300,
    });
    expect(decideContextLifecycle({ ...base, safeBoundary: true })).toEqual({
      action: 'compact', reason: 'manual', inputBudgetTokens: 9_300,
    });
  });

  it('runs compaction once through the supplied model gateway with tools disabled', async () => {
    const calls: Array<{ request: unknown; options: unknown; session: unknown }> = [];
    const execution = {
      attempt: {
        attemptId: 'attempt-compact',
        origin: { connectionId: 'conn', model: 'model', protocol: 'openai-chat' },
        blocks: [{ type: 'text', text: 'bounded committed summary' }],
        terminal: true,
        validation: 'validated',
        finishReason: 'stop',
        opaqueBlockRefs: [],
      },
      session: { route: { routeId: 'compaction-route', modelId: 'model' } },
      discardedAttempts: [],
    } as unknown as ModelAttemptExecution;
    const gateway = {
      executeAttempt(session: ModelSession | ModelSessionBundle, request: unknown, options: unknown) {
        calls.push({ session, request, options });
        return Promise.resolve(execution);
      },
    };
    const session = { route: { modelId: 'model' } } as unknown as ModelSession;
    const lifecycle = new ContextLifecycle({ gateway, session });
    const result = await lifecycle.compact({
      decisionId: 'decision-1',
      committedThroughSequence: 41,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'committed history' }] }],
      signal: new AbortController().signal,
    });
    expect(result).toEqual({
      status: 'compacted',
      decisionId: 'decision-1',
      committedThroughSequence: 41,
      summary: 'bounded committed summary',
      attemptId: 'attempt-compact',
      routeId: 'compaction-route',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.request).toEqual(expect.objectContaining({ model: 'model' }));
    expect(calls[0]?.request).not.toHaveProperty('tools');
    expect(calls[0]?.options).toEqual(expect.objectContaining({
      purpose: 'context-compaction',
      toolsEnabled: false,
    }));
  });

  it('does not hide a failed compaction or perform an internal retry loop', async () => {
    let calls = 0;
    const lifecycle = new ContextLifecycle({
      gateway: {
        executeAttempt() {
          calls += 1;
          return Promise.reject(new Error('provider unavailable'));
        },
      },
      session: { route: { modelId: 'model' } } as unknown as ModelSession,
    });
    await expect(lifecycle.compact({
      decisionId: 'decision-2',
      committedThroughSequence: 9,
      messages: [],
    })).rejects.toMatchObject({ code: 'CONTEXT_COMPACTION_FAILED' });
    expect(calls).toBe(1);
  });

  it('re-injects authoritative current state after a checkpoint summary', () => {
    const runtime = new PromptRuntime({
      runtimeProtocol: section('runtime-protocol', 'runtime', 0, 'General agent protocol'),
    });
    const compiled = runtime.compile({
      model: 'model',
      checkpoint: {
        summary: 'summary of committed history',
        coveredSequence: 100,
      },
      sections: [
        section('skill-semantic', 'skill', 0, 'Use the current project skill'),
        section('plan-semantic', 'run', 0, 'Current plan: inspect then deliver'),
        section('pending-semantic', 'observation', 0, 'Pending approval for write action'),
      ],
      tools: [{ name: 'workspace_read', inputSchema: { type: 'object' } }],
    });
    expect(compiled.messages.flatMap((message) => message.content).map((block) =>
      block.type === 'text' ? block.text : '').join('\n')).toContain('summary of committed history');
    expect(compiled.messages.flatMap((message) => message.content).map((block) =>
      block.type === 'text' ? block.text : '').join('\n')).toContain('Current plan');
    expect(compiled.tools).toEqual([{ name: 'workspace_read', inputSchema: { type: 'object' } }]);
    const serialized = JSON.stringify(compiled);
    expect(serialized).not.toContain('snapshot-internal-id');
    expect(serialized).not.toContain('coveredSequence');
    expect(serialized).not.toContain('runtime-protocol');
  });

  it('keeps the runtime protocol even when a user role definition uses replace mode', () => {
    const runtime = new PromptRuntime({
      runtimeProtocol: section('runtime', 'runtime', 0, 'Non-bypassable general protocol'),
    });
    const compiled = runtime.compile({
      model: 'model',
      userRoleMode: 'replace',
      sections: [section('user-role', 'user', 0, 'Act as a concise engineer')],
      tools: [],
    });
    expect(compiled.messages[0]?.content).toEqual([
      { type: 'text', text: 'Non-bypassable general protocol' },
    ]);
    expect(compiled.messages[1]?.content).toEqual([
      { type: 'text', text: 'Act as a concise engineer' },
    ]);
  });

  it('applies append and replace semantics to user role contributions', () => {
    const runtime = new PromptRuntime({
      runtimeProtocol: section('runtime', 'runtime', 0, 'General runtime protocol'),
    });
    const userSections = [
      section('user-default', 'user', 0, 'Default user role'),
      section('user-project', 'user', 10, 'Project-specific user role'),
    ];
    const appended = runtime.compile({
      model: 'model', userRoleMode: 'append', sections: userSections, tools: [],
    });
    expect(JSON.stringify(appended.messages)).toContain('Default user role');
    expect(JSON.stringify(appended.messages)).toContain('Project-specific user role');

    const replaced = runtime.compile({
      model: 'model', userRoleMode: 'replace', sections: userSections, tools: [],
    });
    expect(JSON.stringify(replaced.messages)).not.toContain('Default user role');
    expect(JSON.stringify(replaced.messages)).toContain('Project-specific user role');
    expect(JSON.stringify(replaced.messages)).toContain('General runtime protocol');
  });

  it('injects a checkpoint exactly once with multiple session sections', () => {
    const runtime = new PromptRuntime({
      runtimeProtocol: section('runtime', 'runtime', 0, 'General runtime protocol'),
    });
    const compiled = runtime.compile({
      model: 'model',
      checkpoint: { summary: 'one durable checkpoint', coveredSequence: 9 },
      sections: [
        section('session-a', 'session', 0, 'Session fact A'),
        section('session-b', 'session', 1, 'Session fact B'),
      ],
      tools: [],
    });
    expect(JSON.stringify(compiled.messages).match(/one durable checkpoint/gu)).toHaveLength(1);
  });

  it('deep-freezes every compiled prompt input and request branch', () => {
    const runtime = new PromptRuntime({
      runtimeProtocol: section('runtime', 'runtime', 0, 'General runtime protocol'),
    });
    const compiled = runtime.compile({
      model: 'model',
      sections: [section('project', 'project', 0, 'Project fact')],
      tools: [{
        name: 'workspace_read',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      }],
    });
    expect(Object.isFrozen(compiled)).toBe(true);
    expect(Object.isFrozen(compiled.messages[0]?.content)).toBe(true);
    expect(Object.isFrozen(compiled.messages[0]?.content[0])).toBe(true);
    expect(Object.isFrozen(compiled.tools[0]?.inputSchema)).toBe(true);
    expect(Object.isFrozen(compiled.request.messages)).toBe(true);
    expect(Object.isFrozen(compiled.request.messages[0]?.content)).toBe(true);
    expect(Object.isFrozen(compiled.request.tools?.[0]?.inputSchema)).toBe(true);
  });

  it.each([
    { type: 'provider-opaque', opaqueRef: 'opaque-1', protocol: 'x', origin: { connectionId: 'c', model: 'm' }, replay: 'same-connection-only', value: {} },
    { type: 'tool-call-draft', draftCallKey: 'draft-1', name: 'forged', arguments: {} },
    { type: 'reasoning-summary', text: 'summary', derivedFromOpaqueRef: 'opaque-1' },
    { type: 'unknown-protocol-block', value: 'raw' },
  ])('rejects protocol/opaque content from semantic prompt sections: $type', (content) => {
    expectErrorCode(() => new PromptRuntime({
      runtimeProtocol: {
        ...section('runtime', 'runtime', 0, 'General runtime protocol'),
        content: [content as never],
      },
    }), 'PROMPT_SECTION_INVALID');
  });

  it('reads a huge history through bounded run-scoped cursor pages', async () => {
    const readPage = vi.fn(({ afterSequence, limit }: {
      afterSequence: number; limit: number;
    }) => {
      if (limit > 64) throw new Error('unbounded page');
      return Promise.resolve(Array.from({ length: limit }, (_, index) => ({
        sequence: afterSequence + index + 1,
        committed: true,
        semantic: `fact-${afterSequence + index + 1}`,
      })));
    });
    const result = await readBoundedCommittedContext({
      readPage,
      afterSequence: 99_000,
      throughSequence: 200_000,
      pageSize: 64,
      maxEvents: 128,
    });
    expect(result.events).toHaveLength(128);
    expect(result.nextSequence).toBe(99_128);
    expect(result.truncated).toBe(true);
    expect(readPage).toHaveBeenCalledTimes(2);
  });

  it('advances a filtered Session cursor to its fixed boundary after the source is exhausted', async () => {
    const readPage = vi.fn(({ afterSequence }: { afterSequence: number }) =>
      Promise.resolve(afterSequence === 10
        ? [{ sequence: 20 }, { sequence: 40 }]
        : []),
    );
    const result = await readBoundedContextItems({
      readPage,
      afterSequence: 10,
      throughSequence: 100,
      pageSize: 3,
      maxItems: 8,
    });
    expect(result).toEqual({
      items: [{ sequence: 20 }, { sequence: 40 }],
      nextSequence: 100,
      truncated: false,
    });
    expect(readPage).toHaveBeenCalledTimes(1);
  });

  it('uses one bounded lookahead when a filtered Session page exactly fills the item limit', async () => {
    const readPage = vi.fn(({ afterSequence }: { afterSequence: number }) =>
      Promise.resolve(afterSequence === 10
        ? [{ sequence: 20 }, { sequence: 40 }]
        : []),
    );
    const result = await readBoundedContextItems({
      readPage,
      afterSequence: 10,
      throughSequence: 100,
      pageSize: 2,
      maxItems: 2,
    });
    expect(result).toEqual({
      items: [{ sequence: 20 }, { sequence: 40 }],
      nextSequence: 100,
      truncated: false,
    });
    expect(readPage).toHaveBeenLastCalledWith({
      afterSequence: 40, throughSequence: 100, limit: 1,
    });
  });
});

function expectErrorCode(action: () => unknown, code: string): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  if (caught === null || typeof caught !== 'object' || !('code' in caught)) {
    throw new Error(`Expected an error with code ${code}.`);
  }
  expect(caught.code).toBe(code);
}

function section(
  id: string,
  source: PromptSection['source'],
  priority: number,
  text: string,
): PromptSection {
  return {
    id,
    source,
    scope: source === 'runtime' ? 'static' : 'turn',
    priority,
    revision: 'r1',
    cacheability: source === 'observation' ? 'never' : 'stable',
    content: [{ type: 'text', text }],
    tokenEstimate: text.length,
  };
}
