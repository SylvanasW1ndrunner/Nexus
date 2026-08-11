import { describe, expect, it } from 'vitest';
import {
  assertAuthenticRuntimeCommand,
  createRuntimeCommandIssuer,
  isAuthenticRuntimeCommand,
} from '../src/internal/runtime-command-authority.js';

const base = {
  schemaVersion: 1 as const,
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
      ...base, kind: 'tool.activate', payload: { names: ['workspace_read'] },
    });
    expect(() => assertAuthenticRuntimeCommand({ ...command })).toThrowError(
      expect.objectContaining({ code: 'RUNTIME_COMMAND_UNAUTHENTIC' }),
    );
    expect(() => assertAuthenticRuntimeCommand(structuredClone(command))).toThrowError(
      expect.objectContaining({ code: 'RUNTIME_COMMAND_UNAUTHENTIC' }),
    );
  });

  it('rejects functions, secrets, open keys and unbounded lists', () => {
    const issuer = createRuntimeCommandIssuer();
    expect(() => issuer.issue({
      ...base, kind: 'child.start', payload: { task: 'work', context: (() => 1) as never },
    })).toThrowError(expect.objectContaining({ code: 'RUNTIME_COMMAND_INVALID' }));
    expect(() => issuer.issue({
      ...base, kind: 'child.start', payload: { task: 'work', context: { apiKey: 'secret' } },
    })).toThrowError(expect.objectContaining({ code: 'RUNTIME_COMMAND_INVALID' }));
    expect(() => issuer.issue({
      ...base, kind: 'tool.activate', payload: { names: ['ok'], extra: true } as never,
    })).toThrowError(expect.objectContaining({ code: 'RUNTIME_COMMAND_INVALID' }));
    expect(() => issuer.issue({
      ...base, kind: 'skill.activate', payload: { ids: Array.from({ length: 257 }, (_, i) => `s-${i}`) },
    })).toThrowError(expect.objectContaining({ code: 'RUNTIME_COMMAND_INVALID' }));
  });
});
