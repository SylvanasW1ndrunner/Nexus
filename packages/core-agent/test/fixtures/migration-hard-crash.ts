import { StateMigrationRunner, type MigrationCrashPoint } from '../../src/session/state-migrations.js';

const projectDir = process.env.DBAGENT_MIGRATION_CHILD_PROJECT;
const crashAt = process.env.DBAGENT_MIGRATION_HARD_CRASH as MigrationCrashPoint | undefined;
if (projectDir === undefined || crashAt === undefined) throw new Error('Migration child input is missing.');

await StateMigrationRunner.open(projectDir, {
  targetSchemaVersion: 2,
  migratorRevision: 'task-4-r1',
  crashAt,
});
