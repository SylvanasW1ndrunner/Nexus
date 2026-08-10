import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('built-package Tool authority boundaries', () => {
  it('does not expose an Invocation Handler through root exports or reflected public objects', async () => {
    const consumer = await createConsumer();
    try {
      const result = await runConsumer(consumer.root, `
        const api = await import('@dbagent/core-agent');
        let calls = 0;
        const rawHandler = () => {
          calls += 1;
          return api.createAgentToolResultEnvelope({
            modelProjection: { ok: true }, durableSummary: { ok: true },
          });
        };
        const registry = new api.ToolRegistry();
        registry.registerInvocation({
          name: 'sealed_tool', description: 'sealed fixture', dangerLevel: 'safe',
          readonly: true, effect: 'read', handlerRevision: 'sealed_tool@1',
          requiredPermission: 'read', exposure: 'direct', execution: { concurrency: 'read' },
          inputSchema: { type: 'object' },
        }, { execute: rawHandler });
        const snapshot = registry.captureSnapshot();
        let constructorError;
        try {
          new api.ToolCatalogSnapshot();
          constructorError = 'CONSTRUCTED';
        } catch (error) {
          constructorError = { name: error.name, message: error.message };
        }

        function containsReference(root, target, seen = new Set()) {
          if (root === target) return true;
          if ((typeof root !== 'object' && typeof root !== 'function') || root === null) return false;
          if (seen.has(root)) return false;
          seen.add(root);
          if (root instanceof Map) {
            for (const [key, value] of root) {
              if (containsReference(key, target, seen) || containsReference(value, target, seen)) {
                return true;
              }
            }
          }
          if (root instanceof Set) {
            for (const value of root) if (containsReference(value, target, seen)) return true;
          }
          for (const key of Reflect.ownKeys(root)) {
            const descriptor = Reflect.getOwnPropertyDescriptor(root, key);
            if (descriptor && 'value' in descriptor && containsReference(descriptor.value, target, seen)) {
              return true;
            }
          }
          const prototype = Reflect.getPrototypeOf(root);
          return prototype !== null && containsReference(prototype, target, seen);
        }

        console.log(JSON.stringify({
          rootLeak: containsReference(api, rawHandler),
          registryLeak: containsReference(registry, rawHandler),
          snapshotLeak: containsReference(snapshot, rawHandler),
          getter: typeof snapshot.getInvocationRuntime,
          constructorError,
          calls,
        }));
      `);
      expect(JSON.parse(result.stdout) as unknown).toEqual({
        rootLeak: false,
        registryLeak: false,
        snapshotLeak: false,
        getter: 'undefined',
        constructorError: {
          name: 'TypeError',
          message: 'ToolCatalogSnapshot can only be created by ToolRegistry.captureSnapshot().',
        },
        calls: 0,
      });

      const deepImport = await runConsumer(consumer.root, `
        try {
          await import('@dbagent/core-agent/dist/internal/tool-invocation-authority.js');
          console.log('IMPORTED');
        } catch (error) {
          console.log(error.code);
        }
      `);
      expect(deepImport.stdout).toBe('ERR_PACKAGE_PATH_NOT_EXPORTED');
    } finally {
      await rm(consumer.root, { recursive: true, force: true });
    }
  });

  it('keeps Tool lifecycle mutation absent from the public Journal and generic commit path', async () => {
    const consumer = await createConsumer();
    try {
      const journalPath = join(consumer.root, 'authority.db');
      const runtime = await runConsumer(consumer.root, `
        const api = await import('@dbagent/core-agent');
        const journal = new api.SqliteAgentJournal({ filePath: ${JSON.stringify(journalPath)} });
        const created = await journal.createRun({
          projectId: 'project-a', sessionId: 'session-a', clientRequestId: 'request-a', input: 'go',
        });
        const lease = await journal.acquireRunLease({
          projectId: 'project-a', runId: created.runId, ownerId: 'host', ttlMs: 10000,
        });
        const leaseRef = { ownerId: lease.ownerId, fencingToken: lease.fencingToken };
        const codes = [];
        for (const [index, type] of ['tool.authorized', 'tool.succeeded', 'tool.observed'].entries()) {
          try {
            await journal.commit({
              projectId: 'project-a', sessionId: 'session-a', runId: created.runId,
              commandId: 'forge-' + index, lease: leaseRef, expectedRunRevision: 1,
              events: [{ type, payload: {} }],
            });
            codes.push('FORGED');
          } catch (error) {
            codes.push(error.code);
          }
        }
        console.log(JSON.stringify({
          publicCommitter: typeof journal.commitToolInvocation,
          prototypeCommitter: typeof api.SqliteAgentJournal.prototype.commitToolInvocation,
          rootCommitter: typeof api.openToolLifecycleCommitter,
          codes,
        }));
      `);
      expect(JSON.parse(runtime.stdout) as unknown).toEqual({
        publicCommitter: 'undefined',
        prototypeCommitter: 'undefined',
        rootCommitter: 'undefined',
        codes: ['COMMITTER_REQUIRED', 'COMMITTER_REQUIRED', 'COMMITTER_REQUIRED'],
      });

      await writeFile(join(consumer.root, 'consumer.mts'), `
        import { SqliteAgentJournal, ToolCatalogSnapshot } from '@dbagent/core-agent';
        const journal = new SqliteAgentJournal({ filePath: 'authority.db' });
        void journal.commitToolInvocation({} as never);
        new ToolCatalogSnapshot();
      `);
      await writeFile(join(consumer.root, 'tsconfig.json'), JSON.stringify({
        compilerOptions: {
          target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
          strict: true, noEmit: true, skipLibCheck: true,
        },
        files: ['./consumer.mts'],
      }));
      const compileFailure = await runConsumerCompile(consumer.root);
      expect(compileFailure).toMatch(/Property 'commitToolInvocation' does not exist/u);
      expect(compileFailure).toMatch(/Constructor of class 'ToolCatalogSnapshot' is private/u);
    } finally {
      await rm(consumer.root, { recursive: true, force: true });
    }
  });
});

async function createConsumer(): Promise<{ root: string }> {
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const root = await mkdtemp(join(tmpdir(), 'dbagent-tool-authority-consumer-'));
  const packageScope = join(root, 'node_modules', '@dbagent');
  await mkdir(packageScope, { recursive: true });
  await symlink(packageRoot, join(packageScope, 'core-agent'), 'junction');
  return { root };
}

function runConsumer(cwd: string, source: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['--input-type=module', '-e', source], { cwd }, (
      error,
      stdout,
      stderr,
    ) => {
      if (error !== null) {
        reject(new Error(error.message, { cause: Object.assign(error, { stdout, stderr }) }));
        return;
      }
      resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

function runConsumerCompile(cwd: string): Promise<string> {
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const compiler = join(packageRoot, '..', '..', 'node_modules', 'typescript', 'bin', 'tsc');
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [compiler, '--project', 'tsconfig.json'], { cwd }, (
      error,
      stdout,
      stderr,
    ) => {
      if (error === null) {
        reject(new Error('Forged Tool lifecycle consumer unexpectedly compiled.'));
        return;
      }
      resolve(`${stdout}${stderr}`);
    });
  });
}
