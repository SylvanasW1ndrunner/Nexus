import { stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ProjectArtifactStore } from '../../src/artifacts/project-artifact-store.js';
import { SqliteAgentJournal } from '../../src/events/sqlite-agent-journal.js';
import { acquireExclusiveStateWriterGate } from '../../src/session/state-writer-gate.js';

const projectDir = process.env.DBAGENT_ARTIFACT_CHILD_PROJECT;
const mode = process.env.DBAGENT_ARTIFACT_WORKER_MODE;
const operationModes = ['stage', 'commit', 'open', 'expire', 'delete', 'gc'] as const;
type OperationMode = typeof operationModes[number];
if (!projectDir || (mode !== 'hold-state' && !operationModes.includes(mode as OperationMode))) {
  throw new Error('Artifact worker configuration is required.');
}

async function waitForRelease(name: string): Promise<void> {
  await writeFile(join(projectDir!, `${name}-ready`), 'ready');
  while (true) {
    try {
      await stat(join(projectDir!, `${name}-release`));
      return;
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

if (mode === 'hold-state') {
  const gate = acquireExclusiveStateWriterGate(projectDir);
  try {
    await waitForRelease('artifact-state-holder');
  } finally {
    gate.close();
  }
  process.exit(0);
}

const journal = new SqliteAgentJournal({
  filePath: join(projectDir, 'state.db'),
  now: () => '2026-08-09T12:00:00.000Z',
});
const store = new ProjectArtifactStore({
  projectId: 'project-a',
  rootDir: join(projectDir, 'artifacts'),
  journal,
  ...(mode === 'commit' && process.env.DBAGENT_ARTIFACT_COMMIT_BARRIER === '1' ? {
    afterCommitBytesVerified: async () => {
      await waitForRelease('artifact-commit');
    },
  } : {}),
});

try {
  await writeFile(join(projectDir, `artifact-${mode}-started`), 'started');
  const input = process.env.DBAGENT_ARTIFACT_OPERATION_INPUT === undefined
    ? undefined
    : JSON.parse(process.env.DBAGENT_ARTIFACT_OPERATION_INPUT) as unknown;
  if (mode === 'stage') {
    async function* source() {
      yield Buffer.from('live-stage');
      if (process.env.DBAGENT_ARTIFACT_STAGE_BARRIER === '1') {
        await waitForRelease('artifact-stage');
      }
    }
    await store.stage({ mediaType: 'text/plain', source: source() });
  } else if (mode === 'commit') {
    await store.commit(input as Parameters<ProjectArtifactStore['commit']>[0]);
  } else if (mode === 'open') {
    await new Response(
      await store.open(input as Parameters<ProjectArtifactStore['open']>[0]),
    ).arrayBuffer();
  } else if (mode === 'expire') {
    const operation = input as {
      ref: Parameters<ProjectArtifactStore['expire']>[0];
      context: Parameters<ProjectArtifactStore['expire']>[1];
    };
    await store.expire(operation.ref, operation.context);
  } else if (mode === 'delete') {
    const operation = input as {
      ref: Parameters<ProjectArtifactStore['delete']>[0];
      context: Parameters<ProjectArtifactStore['delete']>[1];
    };
    await store.delete(operation.ref, operation.context);
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
