import type {
  ToolInvocationCommitResult,
  ToolInvocationJournalCommand,
} from '../events/agent-journal.js';
import type { PreparedToolArtifactCommit } from './prepared-tool-artifact-authority.js';
import type { RuntimeCommand } from '../kernel/runtime-command.js';

/**
 * Package-private authority for writing Tool Invocation lifecycle facts.
 *
 * Keeping the capability in a module-scoped WeakMap means neither the public
 * Journal surface nor reflective traversal of a Journal instance can recover
 * the committer. Only the unified Tool Runtime imports this internal module.
 */
export type ToolLifecycleCommitter = Readonly<{
  commit(
    command: ToolInvocationJournalCommand,
    options?: Readonly<{
      preparedArtifacts?: readonly PreparedToolArtifactCommit[];
      runtimeCommand?: RuntimeCommand;
    }>,
  ): Promise<ToolInvocationCommitResult>;
}>;

const lifecycleCommitters = new WeakMap<object, ToolLifecycleCommitter>();

export function bindToolLifecycleCommitter(
  journal: object,
  commit: ToolLifecycleCommitter['commit'],
): void {
  if (lifecycleCommitters.has(journal)) {
    throw new TypeError('Tool lifecycle authority is already bound to this Journal.');
  }
  lifecycleCommitters.set(journal, Object.freeze({ commit }));
}

export function openToolLifecycleCommitter(journal: object): ToolLifecycleCommitter {
  const committer = lifecycleCommitters.get(journal);
  if (committer === undefined) {
    throw new TypeError('Journal is not bound to the Tool lifecycle authority.');
  }
  return committer;
}
