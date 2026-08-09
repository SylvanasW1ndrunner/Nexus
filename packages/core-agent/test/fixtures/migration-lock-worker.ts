import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentSessionStore } from '../../src/session-store.js';
import { StateMigrationRunner } from '../../src/session/state-migrations.js';

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
  } else {
    throw new Error(`Unknown migration worker mode: ${mode}`);
  }
} catch (error) {
  await writeFile(join(projectDir, `${mode}-worker-error`), error instanceof Error
    ? `${error.name}: ${error.message}\n${error.stack ?? ''}`
    : String(error));
  throw error;
}
