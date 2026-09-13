import type { AgentJournal } from '../events/agent-journal.js';
import type { SessionStateCommitter } from '../session/session-journal.js';

const COMMITTERS = new WeakMap<AgentJournal, SessionStateCommitter>();

export function bindSessionStateCommitter(
  journal: AgentJournal,
  committer: SessionStateCommitter,
): void {
  if (COMMITTERS.has(journal)) throw new TypeError('Session state committer is already bound.');
  COMMITTERS.set(journal, Object.freeze(committer));
}

export function openSessionStateCommitter(journal: AgentJournal): SessionStateCommitter {
  const committer = COMMITTERS.get(journal);
  if (committer === undefined) {
    throw new TypeError('Journal does not expose the sealed Session state authority.');
  }
  return committer;
}
