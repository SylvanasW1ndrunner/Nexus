import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AgentSessionStore,
  JournalSessionStore,
  ProjectArtifactStore,
  openProjectStateMigration,
  createAgentSession,
  projectSession,
} from '../src/index.js';

describe('persistence root exports', () => {
  it('keeps the legacy runtime usable while exposing Journal persistence separately', () => {
    const session = createAgentSession({
      id: 'legacy-runtime-session',
      title: 'Legacy runtime',
      mode: 'read',
      now: () => '2026-08-10T00:00:00.000Z',
    });
    expect(session).toMatchObject({ id: 'legacy-runtime-session', messages: [], aborted: false });
    expect(AgentSessionStore).toBeTypeOf('function');
    expect(JournalSessionStore).toBeTypeOf('function');
    expect(ProjectArtifactStore).toBeTypeOf('function');
    expect(openProjectStateMigration).toBeTypeOf('function');
    expect(projectSession).toBeTypeOf('function');
  });

  it('allows only built-package root imports and rejects authority deep imports and forged commits', async () => {
    const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
    const consumerRoot = await mkdtemp(join(tmpdir(), 'dbagent-core-agent-consumer-'));
    try {
      const packageScope = join(consumerRoot, 'node_modules', '@dbagent');
      await mkdir(packageScope, { recursive: true });
      await symlink(packageRoot, join(packageScope, 'core-agent'), 'junction');

      const rootImport = await runConsumer(consumerRoot, `
        const api = await import('@dbagent/core-agent');
        console.log(
          typeof api.openProjectStateMigration,
          typeof api.StateMigrationRunner,
          typeof api.SqliteAgentJournal,
        );
      `);
      expect(rootImport.stdout.trim()).toBe('function undefined function');

      const constructorForgery = await runConsumer(consumerRoot, `
        const api = await import('@dbagent/core-agent');
        try {
          new api.StateMigrationRunner(${JSON.stringify(consumerRoot)}, {
            finalPath: ${JSON.stringify(join(consumerRoot, '..', 'outside.db'))},
          });
          console.log('FORGED');
        } catch (error) {
          console.log(error.name);
        }
      `);
      expect(constructorForgery.stdout.trim()).toBe('TypeError');

      await writeFile(join(consumerRoot, 'consumer.mts'), `
        import { StateMigrationRunner, type StateMigrationHandle } from '@dbagent/core-agent';
        new StateMigrationRunner('project', {});
        const forged: StateMigrationHandle = {
          activeSchemaVersion: async () => 999,
        };
        void forged;
      `);
      await writeFile(join(consumerRoot, 'tsconfig.json'), JSON.stringify({
        compilerOptions: {
          target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
          strict: true, noEmit: true, skipLibCheck: true,
        },
        files: ['./consumer.mts'],
      }));
      const compileFailure = await runConsumerCompileFailure(consumerRoot);
      expect(compileFailure).toMatch(/has no exported member (?:named )?'StateMigrationRunner'/u);
      expect(compileFailure).toMatch(/not assignable to type 'StateMigrationHandle'|is missing the following/u);

      const deepImport = await runConsumer(consumerRoot, `
        try {
          await import('@dbagent/core-agent/dist/internal/legacy-migration-writer.js');
          console.log('IMPORTED');
        } catch (error) {
          console.log(error.code);
        }
      `);
      expect(deepImport.stdout.trim()).toBe('ERR_PACKAGE_PATH_NOT_EXPORTED');

      const journalPath = join(consumerRoot, 'forgery.db');
      const forgery = await runConsumer(consumerRoot, `
        const { SqliteAgentJournal } = await import('@dbagent/core-agent');
        const journal = new SqliteAgentJournal({ filePath: ${JSON.stringify(journalPath)} });
        const created = await journal.createRun({
          projectId: 'project-a', sessionId: 'session-a', clientRequestId: 'request-a', input: 'a',
        });
        const lease = await journal.acquireRunLease({
          projectId: 'project-a', runId: created.runId, ownerId: 'consumer', ttlMs: 10000,
        });
        try {
          await journal.commit({
            projectId: 'project-a', sessionId: 'session-a', runId: created.runId,
            commandId: 'forged-reserved-commit',
            lease: { ownerId: lease.ownerId, fencingToken: lease.fencingToken },
            expectedRunRevision: 1,
            events: [{ type: 'run.completed', payload: {} }],
          });
          console.log('FORGED');
        } catch (error) {
          console.log(error.code);
        }
      `);
      expect(forgery.stdout.trim()).toBe('COMMITTER_REQUIRED');
    } finally {
      await rm(consumerRoot, { recursive: true, force: true });
    }
  });
});

function runConsumer(cwd: string, source: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['--input-type=module', '-e', source], { cwd }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(error.message, { cause: Object.assign(error, { stdout, stderr }) }));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function runConsumerCompileFailure(cwd: string): Promise<string> {
  const compiler = join(process.cwd(), 'node_modules', 'typescript', 'bin', 'tsc');
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [compiler, '--project', 'tsconfig.json'], { cwd }, (
      error,
      stdout,
      stderr,
    ) => {
      if (error === null) {
        reject(new Error('Forged migration consumer unexpectedly compiled.'));
        return;
      }
      resolve(`${stdout}${stderr}`);
    });
  });
}
