import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentSessionStore } from '../../src/session-store.js';
import { StateMigrationRunner } from '../../src/session/state-migrations.js';
import { AgentAuditLogStore } from '../../src/audit-log-store.js';
import { AgentCheckpointStore } from '../../src/checkpoint-store.js';
import { AgentStreamStore } from '../../src/stream-store.js';
import { ProjectArtifactStore } from '../../src/artifacts/project-artifact-store.js';
import { SqliteAgentJournal } from '../../src/events/sqlite-agent-journal.js';

const projectDir = process.env.DBAGENT_MIGRATION_CHILD_PROJECT;
const mode = process.env.DBAGENT_MIGRATION_LOCK_WORKER_MODE;
if (projectDir === undefined || mode === undefined) throw new Error('Migration worker input is missing.');

try {
  if (mode === 'migrate') {
    await StateMigrationRunner.open(projectDir, {
      targetSchemaVersion: 2,
      migratorRevision: 'task-4-r2',
    });
  } else if (mode === 'write') {
    await writeFile(join(projectDir, 'legacy-writer-started'), 'started');
    const store = new AgentSessionStore(join(projectDir, 'state.db'));
    await store.update('session-a', { title: 'writer-won-the-race' });
    await writeFile(join(projectDir, 'legacy-writer-completed'), 'completed');
  } else if (mode === 'audit' || mode === 'checkpoint' || mode === 'stream' || mode === 'artifact') {
    await writeFile(join(projectDir, `${mode}-writer-started`), 'started');
    if (mode === 'audit') {
      await new AgentAuditLogStore(join(projectDir, 'legacy-audit.jsonl')).append({
        type: 'run_finished', timestamp: '2026-08-08T03:00:00.000Z', sessionId: 'session-a',
        status: 'done', iterations: 1, durationMs: 1,
      });
    } else if (mode === 'checkpoint') {
      await new AgentCheckpointStore(join(projectDir, 'legacy-checkpoints', 'writer.json')).save({
        session: {
          id: 'session-a', title: 'writer', mode: 'read', messages: [],
          tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, aborted: false,
        },
        iteration: 1, status: 'running', toolExecutions: [], now: '2026-08-08T03:00:00.000Z',
      });
    } else if (mode === 'stream') {
      await new AgentStreamStore(join(projectDir, 'legacy-streams', 'writer.json')).start({
        id: 'writer-stream', sessionId: 'session-a', providerId: 'provider', model: 'model',
        now: '2026-08-08T03:00:00.000Z',
      });
    } else {
      const journal = new SqliteAgentJournal({ filePath: join(projectDir, 'artifact-writer.db') });
      const store = new ProjectArtifactStore({
        projectId: 'legacy-writer', rootDir: join(projectDir, 'legacy-artifacts'), journal,
      });
      await store.stage({
        mediaType: 'text/plain', source: (async function* () {
          await Promise.resolve();
          yield new TextEncoder().encode('writer artifact');
        })(),
      });
    }
    await writeFile(join(projectDir, `${mode}-writer-completed`), 'completed');
  } else {
    throw new Error(`Unknown migration worker mode: ${mode}`);
  }
} catch (error) {
  await writeFile(join(projectDir, `${mode}-worker-error`), error instanceof Error
    ? `${error.name}: ${error.message}\n${error.stack ?? ''}`
    : String(error));
  throw error;
}
