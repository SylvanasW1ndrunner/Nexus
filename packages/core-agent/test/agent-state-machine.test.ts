import { describe, expect, it } from 'vitest';
import {
  AgentStateMachineError,
  deriveAgentRunState,
  transitionAgentRunState,
  type AgentRunStateSnapshot,
  type AgentStateSignal,
} from '../src/kernel/agent-state-machine.js';

describe('Agent run state machine', () => {
  const transitionCases: Array<{
    from: AgentRunStateSnapshot;
    signal: AgentStateSignal;
    to: AgentRunStateSnapshot;
  }> = [
    { from: { state: 'created' }, signal: { type: 'run-started' }, to: { state: 'Preparing' } },
    {
      from: { state: 'Preparing' },
      signal: { type: 'context-compaction-required' },
      to: { state: 'Compacting' },
    },
    {
      from: { state: 'Compacting' },
      signal: { type: 'context-compacted' },
      to: { state: 'Preparing' },
    },
    {
      from: { state: 'Preparing' },
      signal: { type: 'context-ready' },
      to: { state: 'CallingModel' },
    },
    {
      from: { state: 'CallingModel' },
      signal: { type: 'model-attempt-started' },
      to: { state: 'ReceivingModel' },
    },
    {
      from: { state: 'ReceivingModel' },
      signal: { type: 'model-attempt-committed', hasActions: true },
      to: { state: 'ResolvingActions' },
    },
    {
      from: { state: 'ReceivingModel' },
      signal: { type: 'model-attempt-committed', hasActions: false },
      to: { state: 'Finalizing' },
    },
    {
      from: { state: 'ResolvingActions' },
      signal: {
        type: 'schedule-decided',
        decision: { state: 'AwaitingUser', reason: 'approval', invocationIds: ['i-1'] },
      },
      to: { state: 'AwaitingUser', waitReason: 'approval' },
    },
    {
      from: { state: 'ResolvingActions' },
      signal: { type: 'schedule-decided', decision: { state: 'ExecutingTools', invocationIds: ['i-1'] } },
      to: { state: 'ExecutingTools' },
    },
    {
      from: { state: 'ExecutingTools' },
      signal: { type: 'schedule-decided', decision: { state: 'ApplyingObservations', invocationIds: ['i-1'] } },
      to: { state: 'ApplyingObservations' },
    },
    {
      from: { state: 'ApplyingObservations' },
      signal: { type: 'turn-observed' },
      to: { state: 'Preparing' },
    },
    {
      from: { state: 'Finalizing' },
      signal: { type: 'delivery-revision-requested' },
      to: { state: 'Preparing' },
    },
    {
      from: { state: 'Finalizing' },
      signal: { type: 'outcome-resolution-required' },
      to: { state: 'AwaitingUser', waitReason: 'outcome_resolution' },
    },
    {
      from: { state: 'Finalizing' },
      signal: { type: 'delivery-accepted' },
      to: { state: 'Completed' },
    },
    {
      from: { state: 'Cancelling' },
      signal: { type: 'cancellation-settled' },
      to: { state: 'Cancelled' },
    },
    {
      from: { state: 'LimitReached' },
      signal: { type: 'run-resumed', resumeState: 'Preparing' },
      to: { state: 'Preparing' },
    },
    {
      from: { state: 'Interrupted' },
      signal: { type: 'run-resumed', resumeState: 'ResolvingActions' },
      to: { state: 'ResolvingActions' },
    },
  ];
  it.each(transitionCases)('$from.state + $signal.type -> $to.state', ({ from, signal, to }) => {
    expect(transitionAgentRunState(from, signal)).toEqual(to);
  });

  it.each([
    'Preparing',
    'Compacting',
    'CallingModel',
    'ReceivingModel',
    'ResolvingActions',
    'AwaitingUser',
    'ExecutingTools',
    'ApplyingObservations',
    'Finalizing',
    'LimitReached',
    'Interrupted',
  ] as const)('routes cancellation from %s through Cancelling', (state) => {
    expect(transitionAgentRunState(
      state === 'AwaitingUser' ? { state, waitReason: 'input_required' } : { state },
      { type: 'cancel-requested' },
    )).toEqual({ state: 'Cancelling' });
  });

  it('rejects an impossible transition with one typed projection error', () => {
    expect(() => transitionAgentRunState(
      { state: 'Completed' },
      { type: 'context-ready' },
    )).toThrowError(expect.objectContaining<Partial<AgentStateMachineError>>({
      code: 'RUN_PROJECTION_INVALID',
    }));
  });

  it('does not complete while an external outcome is unresolved', () => {
    expect(deriveAgentRunState({
      current: { state: 'Finalizing' },
      openAttempt: false,
      pendingApproval: false,
      pendingInput: false,
      unresolvedOutcomes: 1,
      committedInvocationCount: 1,
      observationCount: 1,
      finalContentRef: 'artifact:final',
      delivery: { status: 'verified', evidenceRevision: 7 },
    })).toEqual({ state: 'AwaitingUser', waitReason: 'outcome_resolution' });
  });

  it('does not complete with an open attempt or a missing observation', () => {
    const base = {
      current: { state: 'Finalizing' } as const,
      pendingApproval: false,
      pendingInput: false,
      unresolvedOutcomes: 0,
      finalContentRef: 'artifact:final',
      delivery: { status: 'verified' as const, evidenceRevision: 7 },
    };
    expect(() => deriveAgentRunState({
      ...base,
      openAttempt: true,
      committedInvocationCount: 0,
      observationCount: 0,
    })).toThrowError(expect.objectContaining({ code: 'RUN_PROJECTION_INVALID' }));
    expect(() => deriveAgentRunState({
      ...base,
      openAttempt: false,
      committedInvocationCount: 2,
      observationCount: 1,
    })).toThrowError(expect.objectContaining({ code: 'RUN_PROJECTION_INVALID' }));
  });

  it('completes only from committed final content and the matching delivery decision', () => {
    expect(deriveAgentRunState({
      current: { state: 'Finalizing' },
      openAttempt: false,
      pendingApproval: false,
      pendingInput: false,
      unresolvedOutcomes: 0,
      committedInvocationCount: 2,
      observationCount: 2,
      finalContentRef: 'artifact:final',
      delivery: { status: 'unverified', evidenceRevision: 11 },
    })).toEqual({ state: 'Completed' });
  });
});
