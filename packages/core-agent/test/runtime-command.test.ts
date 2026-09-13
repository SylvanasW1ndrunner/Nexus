import { describe, expect, it } from 'vitest';
import {
  assertAuthenticRuntimeCommand,
  createRuntimeCommandIssuer,
  isAuthenticRuntimeCommand,
} from '../src/internal/runtime-command-authority.js';
import { RuntimeCommandError } from '../src/kernel/runtime-command.js';

const base = {
  schemaVersion: 2 as const,
  commandId: 'command-1',
  origin: { runId: 'run-1', turnId: 'turn-1', invocationId: 'invocation-1' },
  expectedRunRevision: 3,
  fencingToken: 1,
};

describe('sealed Runtime Commands', () => {
  it('issues a deeply immutable portable command', () => {
    const command = createRuntimeCommandIssuer().issue({
      ...base, kind: 'plan.create', payload: { planId: 'plan-1', plan: { goal: 'inspect' } },
    });
    expect(isAuthenticRuntimeCommand(command)).toBe(true);
    expect(Object.isFrozen(command.payload)).toBe(true);
    expect(Object.isFrozen(command.origin)).toBe(true);
  });

  it('rejects plain-object and structured-clone forgeries', () => {
    const command = createRuntimeCommandIssuer().issue({
      ...base,
      kind: 'discovery.activate',
      payload: {
        tools: [{ name: 'workspace_read', toolRevision: 'workspace_read@1', handlerRevision: 'workspace_read-handler@1' }],
        targets: [],
        bindings: [],
      },
    });
    expectRuntimeCommandError(
      () => assertAuthenticRuntimeCommand({ ...command }), 'RUNTIME_COMMAND_UNAUTHENTIC',
    );
    expectRuntimeCommandError(
      () => assertAuthenticRuntimeCommand(structuredClone(command)),
      'RUNTIME_COMMAND_UNAUTHENTIC',
    );
  });

  it('rejects non-portable values, open keys and unbounded lists', () => {
    const issuer = createRuntimeCommandIssuer();
    expectRuntimeCommandError(() => issuer.issue({
      ...base, kind: 'child.start', payload: { task: 'work', context: (() => 1) as never },
    }), 'RUNTIME_COMMAND_INVALID');
    const command = issuer.issue({
      ...base, kind: 'child.start', payload: { task: 'work', context: { apiKey: 'secret' } },
    });
    expect(command.payload).toEqual({ task: 'work', context: { apiKey: 'secret' } });
    expectRuntimeCommandError(() => issuer.issue({
      ...base,
      kind: 'discovery.activate',
      payload: { tools: [], targets: [], bindings: [], extra: true } as never,
    }), 'RUNTIME_COMMAND_INVALID');
    expectRuntimeCommandError(() => issuer.issue({
      ...base,
      kind: 'skill.activate',
      payload: { activations: Array.from({ length: 257 }, (_, i) => skillActivation(`s-${i}`)) },
    }), 'RUNTIME_COMMAND_INVALID');
  });
});

function skillActivation(id: string) {
  return {
    id,
    revision: {
      schemaVersion: 1 as const,
      revisionId: `${id}@1`,
      scope: 'project' as const,
      sourceId: `${id}-source`,
      sourcePath: `C:/project/.schemanaut/skills/${id}`,
      bundleRoot: 'C:/project/.schemanaut/skills',
      sourceOrder: 0,
      name: id,
      contentDigest: `${id}-content`,
      bundleDigest: `${id}-bundle`,
    },
  };
}

function expectRuntimeCommandError(
  action: () => unknown,
  code: RuntimeCommandError['code'],
): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  if (!(caught instanceof RuntimeCommandError)) {
    throw new Error('Expected RuntimeCommandError.');
  }
  expect(caught.code).toBe(code);
}
