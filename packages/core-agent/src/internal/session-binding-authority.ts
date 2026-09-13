import type {
  BindPersistedSessionModelCommand,
  SessionModelBinding,
} from '../kernel/session-model-binding.js';

type SessionBindingCommitter = Readonly<{
  commit(command: BindPersistedSessionModelCommand): Promise<SessionModelBinding>;
}>;
const committers = new WeakMap<object, SessionBindingCommitter>();

export function bindSessionBindingCommitter(
  journal: object,
  commit: (command: BindPersistedSessionModelCommand) => Promise<SessionModelBinding>,
): void {
  if (committers.has(journal)) throw new TypeError('Session binding authority is already bound.');
  committers.set(journal, Object.freeze({ commit }));
}

export function openSessionBindingCommitter(journal: object): SessionBindingCommitter {
  const committer = committers.get(journal);
  if (committer === undefined) throw new TypeError('Journal has no Session binding authority.');
  return committer;
}
