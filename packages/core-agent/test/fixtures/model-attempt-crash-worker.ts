import { appendFileSync } from 'node:fs';
import { RunEventCommitter } from '../../src/events/run-event-committer.js';
import { SqliteAgentJournal } from '../../src/events/sqlite-agent-journal.js';
import { RunController } from '../../src/kernel/run-controller.js';
import { validatedTextAttemptFixture } from '../validated-attempt-fixture.js';

type Input = {
  journalPath: string; counterPath: string; runId: string;
  expectedRunRevision: number;
  leaseTtlMs: number;
  now: string;
  mode: 'before-commit' | 'after-commit';
};
const input = JSON.parse(process.env.DBAGENT_MODEL_CRASH_INPUT ?? '') as Input;
const journal = new SqliteAgentJournal({ filePath: input.journalPath, now: () => input.now });
const controller = new RunController({
  journal, projectId: 'project-1', sessionId: 'session-1', runId: input.runId,
  ownerId: 'crash-worker', leaseTtlMs: input.leaseTtlMs,
});
await controller.acquire();
const started = await controller.startModelAttempt({
  commandId: 'child-attempt-start', expectedRunRevision: input.expectedRunRevision,
  turnId: 'turn-crash', expectedTurnRevision: 1, attemptId: 'attempt-crash',
  origin: { connectionId: 'connection-1', model: 'model-1', protocol: 'openai-responses' },
});
appendFileSync(input.counterPath, 'provider-call\n');
const attempt = await validatedTextAttemptFixture('attempt-crash', 'Committed before restart.');
if (input.mode === 'before-commit') process.exit(73);
const lease = controller.currentLease();
await new RunEventCommitter(journal).commitValidatedAttempt({
  projectId: 'project-1', sessionId: 'session-1', runId: input.runId,
  turnId: 'turn-crash', commandId: 'child-attempt-commit',
  lease: { ownerId: lease.ownerId, fencingToken: lease.fencingToken },
  expectedRunRevision: started.run.revision, expectedTurnRevision: 1, billingMode: 'byok', attempt,
});
process.exit(74);
