import type {
  KernelJournalCommand,
  KernelJournalCommitResult,
} from '../kernel/run-controller.js';

export type KernelJournalCommitter = Readonly<{
  commit(command: KernelJournalCommand): Promise<KernelJournalCommitResult>;
}>;

const committers = new WeakMap<object, KernelJournalCommitter>();

export function bindKernelJournalCommitter(
  journal: object,
  commit: (command: KernelJournalCommand) => Promise<KernelJournalCommitResult>,
): void {
  if (committers.has(journal)) {
    throw new TypeError('Kernel Journal authority is already bound to this Journal.');
  }
  committers.set(journal, Object.freeze({ commit }));
}

export function openKernelJournalCommitter(journal: object): KernelJournalCommitter {
  const committer = committers.get(journal);
  if (committer === undefined) {
    throw new TypeError('Journal is not bound to the Kernel Journal authority.');
  }
  return committer;
}
