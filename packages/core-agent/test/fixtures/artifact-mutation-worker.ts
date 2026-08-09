import { stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ProjectArtifactStore } from '../../src/artifacts/project-artifact-store.js';
import { SqliteAgentJournal } from '../../src/events/sqlite-agent-journal.js';

const projectDir = process.env.DBAGENT_ARTIFACT_CHILD_PROJECT;
const mode = process.env.DBAGENT_ARTIFACT_WORKER_MODE;
if (!projectDir || (mode !== 'commit' && mode !== 'gc')) {
  throw new Error('Artifact worker configuration is required.');
}

const journal = new SqliteAgentJournal({
  filePath: join(projectDir, 'state.db'),
  now: () => '2026-08-09T12:00:00.000Z',
});
const store = new ProjectArtifactStore({
  projectId: 'project-a',
  rootDir: join(projectDir, 'artifacts'),
  journal,
  ...(mode === 'commit' ? {
    afterCommitBytesVerified: async () => {
      await writeFile(join(projectDir, 'artifact-commit-ready'), 'ready');
      while (true) {
        try {
          await stat(join(projectDir, 'artifact-commit-release'));
          return;
        } catch (error) {
          if ((error as { code?: string }).code !== 'ENOENT') throw error;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
    },
  } : {}),
});

try {
  await writeFile(join(projectDir, `artifact-${mode}-started`), 'started');
  if (mode === 'commit') {
    const input = JSON.parse(process.env.DBAGENT_ARTIFACT_COMMIT_INPUT ?? '') as Parameters<
      ProjectArtifactStore['commit']
    >[0];
    await store.commit(input);
  } else {
    const report = await store.collectGarbage(new Date('2026-08-09T13:00:00.000Z'));
    await writeFile(join(projectDir, 'artifact-gc-report'), JSON.stringify(report));
  }
  await writeFile(join(projectDir, `artifact-${mode}-completed`), 'completed');
} catch (error) {
  await writeFile(
    join(projectDir, `artifact-${mode}-error`),
    error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  );
  process.exitCode = 1;
}
