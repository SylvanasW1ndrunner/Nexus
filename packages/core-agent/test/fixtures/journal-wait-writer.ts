import { SqliteAgentJournal } from '../../src/events/sqlite-agent-journal.js';

type WriterInput = Readonly<{
  filePath: string;
  projectId: string;
  sessionId: string;
  runId: string;
}>;

const encoded = process.env.SCHEMANAUT_JOURNAL_WAIT_WRITER;
if (encoded === undefined) throw new Error('SCHEMANAUT_JOURNAL_WAIT_WRITER is required.');
const input = JSON.parse(encoded) as WriterInput;
const journal = new SqliteAgentJournal({ filePath: input.filePath });
const lease = await journal.acquireRunLease({
  projectId: input.projectId,
  runId: input.runId,
  ownerId: 'independent-wait-writer',
  ttlMs: 60_000,
});
await journal.startRun({
  projectId: input.projectId,
  sessionId: input.sessionId,
  runId: input.runId,
  commandId: 'independent-wait-writer-start',
  lease: { ownerId: lease.ownerId, fencingToken: lease.fencingToken },
  expectedRunRevision: 1,
});
