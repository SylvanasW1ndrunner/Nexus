import type { AgentEvent } from '../events/agent-event.js';
import type { AgentJournal } from '../events/agent-journal.js';
import type { PortableValue } from '@dbagent/shared';
import { assertAuthenticRuntimeCommand } from './runtime-command-authority.js';
import type { RuntimeCommand } from '../kernel/runtime-command.js';
import type { AgentSubagentObservation } from '../subagent-pool.js';

/** Non-executable identity reconstructed only from durable child.start facts. */
export type DurableSubagentOutcomeRecovery = Readonly<{
  commandId: string;
  origin: Readonly<{ runId: string; turnId: string; invocationId: string }>;
  childRunId: string;
  childSessionId: string;
  task: string;
  context: PortableValue;
}>;

export type SubagentOutcomeCommitter = Readonly<{
  commit(
    command: Extract<RuntimeCommand, { kind: 'child.start' }>,
    observation: AgentSubagentObservation,
  ): Promise<AgentEvent<'subagent.completed' | 'subagent.failed' | 'subagent.cancelled'>>;
}>;

type BoundOutcomeCommitter = Readonly<{
  commitFresh: SubagentOutcomeCommitter['commit'];
  commitRecovery: (
    recovery: DurableSubagentOutcomeRecovery,
    observation: AgentSubagentObservation,
  ) => Promise<AgentEvent<'subagent.completed' | 'subagent.failed' | 'subagent.cancelled'>>;
}>;

const committers = new WeakMap<object, BoundOutcomeCommitter>();

export function bindSubagentOutcomeCommitter(
  journal: AgentJournal,
  committer: BoundOutcomeCommitter,
): void {
  if (committers.has(journal)) throw new Error('Subagent outcome committer is already bound.');
  committers.set(journal, committer);
}

export function openSubagentOutcomeCommitter(
  journal: object,
): SubagentOutcomeCommitter | undefined {
  const committer = committers.get(journal);
  if (committer === undefined) return undefined;
  return Object.freeze({
    async commit(command, observation) {
      assertAuthenticRuntimeCommand(command);
      return await committer.commitFresh(command, structuredClone(observation));
    },
  });
}

/**
 * Recovery is not a new Runtime Command admission path. The scheduler may
 * reconstruct the already-committed child.start envelope solely to reconcile
 * its terminal fact. The bound Journal rechecks the durable start fact before
 * it writes anything, so this deliberately bypasses the ephemeral issuer
 * token that cannot survive a process restart.
 */
export function openSubagentOutcomeRecoveryCommitter(
  journal: object,
): Readonly<{
  commit(
    recovery: DurableSubagentOutcomeRecovery,
    observation: AgentSubagentObservation,
  ): Promise<AgentEvent<'subagent.completed' | 'subagent.failed' | 'subagent.cancelled'>>;
}> | undefined {
  const committer = committers.get(journal);
  if (committer === undefined) return undefined;
  return Object.freeze({
    async commit(recovery, observation) {
      // This is a narrow, non-executable durable identity. The Journal checks
      // it against immutable runtime.command_applied facts; no lease or Run
      // revision fields exist on the recovery input surface.
      return await committer.commitRecovery(recovery, structuredClone(observation));
    },
  });
}
