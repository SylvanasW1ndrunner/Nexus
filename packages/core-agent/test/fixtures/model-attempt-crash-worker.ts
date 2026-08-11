import { appendFileSync } from 'node:fs';
import { RunEventCommitter } from '../../src/events/run-event-committer.js';
import { SqliteAgentJournal } from '../../src/events/sqlite-agent-journal.js';
import { RunController } from '../../src/kernel/run-controller.js';
import { validatedAttemptFixture } from '../validated-attempt-fixture.js';

type Input = {
  journalPath: string; counterPath: string; runId: string;
  mode: 'before-commit' | 'after-commit';
};
const input = JSON.parse(process.env.DBAGENT_MODEL_CRASH_INPUT ?? '') as Input;
const journal = new SqliteAgentJournal({ filePath: input.journalPath });
const controller = new RunController({
  journal, projectId: 'project-1', sessionId: 'session-1', runId: input.runId,
  ownerId: 'owner-1', leaseTtlMs: 60_000,
});
await controller.acquire();
const started = await controller.startModelAttempt({
  commandId: 'child-attempt-start', expectedRunRevision: 2,
  turnId: 'turn-crash', expectedTurnRevision: 1, attemptId: 'attempt-crash',
  origin: { connectionId: 'connection-current', model: 'model-current', protocol: 'openai-responses' },
});
appendFileSync(input.counterPath, 'provider-call\n');
const attempt = await validatedAttemptFixture('attempt-crash');
if (input.mode === 'before-commit') process.exit(73);
await new RunEventCommitter(journal).commitValidatedAttempt({
  projectId: 'project-1', sessionId: 'session-1', runId: input.runId,
  turnId: 'turn-crash', commandId: 'child-attempt-commit',
  lease: { ownerId: 'owner-1', fencingToken: 1 },
  expectedRunRevision: started.run.revision, expectedTurnRevision: 1, attempt,
});
process.exit(74);
