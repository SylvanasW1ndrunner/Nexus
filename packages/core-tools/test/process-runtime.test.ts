import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProcessRuntime } from '../src/process-runtime.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.allSettled(cleanups.splice(0).map(cleanup => cleanup())); });
const signal = () => new AbortController().signal;
const owner = { hostId: 'local', sessionId: 'session-runtime', runId: 'run-runtime' };

describe('ProcessRuntime', () => {
  it('retains a bounded spool with byte cursors after foreground completion', async () => {
    const { root, runtime } = await fixture();
    const result = await runtime.exec({ ...owner, signal: signal(), prepared: await prepared(runtime, root, "process.stdout.write('hello'); process.stderr.write('warn');") });
    expect(result).toMatchObject({ status: 'exited', exitCode: 0, treeStopped: process.platform !== 'win32', treeStopProof: process.platform === 'win32' ? 'unverified' : 'verified', output: { stdout: { text: 'hello' }, stderr: { text: 'warn' } } });
  }, 20_000);

  it('recovers a live spool as an orphan that remains readable but cannot be controlled', async () => {
    const { root, runtime } = await fixture();
    const started = await runtime.exec({ ...owner, signal: signal(), background: true, prepared: await prepared(runtime, root, "process.stdout.write('ready'); setTimeout(() => {}, 10000)") });
    const recovered = new ProcessRuntime({ spoolDirectory: join(root, '.spool'), hostId: 'local' });
    cleanups.push(async () => await recovered.close());
    expect(await recovered.recover()).toMatchObject([{ processId: started.processId, status: 'orphaned' }]);
    await expect(recovered.poll({ ...owner, processId: started.processId, signal: signal() })).resolves.toMatchObject({ status: 'orphaned', outputReadable: true });
    await expect(recovered.terminate({ ...owner, processId: started.processId, signal: signal() })).rejects.toMatchObject({ kind: 'precondition' });
    const stopped = runtime.terminate({ ...owner, processId: started.processId, signal: signal() });
    if (process.platform === 'win32') await expect(stopped).rejects.toMatchObject({ kind: 'external', outcome: 'unknown' });
    else await expect(stopped).resolves.toMatchObject({ status: 'terminated', treeStopped: true });
  }, 20_000);

  it.skipIf(process.platform !== 'win32')('does not report success when native tree termination remains unconfirmed', async () => {
    const { root, runtime } = await fixture();
    const child = join(root, 'child.mjs');
    const marker = join(root, 'leaked.txt');
    await writeFile(child, "import { writeFileSync } from 'node:fs'; setTimeout(() => writeFileSync(process.argv[2], 'leaked'), 700); setTimeout(() => process.exit(0), 1200);", 'utf8');
    const source = `require('node:child_process').spawn(process.execPath, ['${child.replaceAll('\\', '\\\\')}', '${marker.replaceAll('\\', '\\\\')}'], { stdio: 'ignore' }); setTimeout(() => {}, 10000);`;
    await expect(runtime.exec({ ...owner, signal: signal(), timeoutMs: 150, prepared: await prepared(runtime, root, nodeCommand(source)) })).rejects.toMatchObject({ kind: 'external', outcome: 'unknown' });
    await delay(1_000);
    await expect(access(marker)).resolves.toBeUndefined();
  }, 20_000);
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'nexus-process-runtime-'));
  const runtime = new ProcessRuntime({ spoolDirectory: join(root, '.spool'), hostId: 'local', retentionMs: 60_000 });
  cleanups.push(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); });
  return { root, runtime };
}

async function prepared(runtime: ProcessRuntime, cwd: string, source: string) {
  return await runtime.prepareExecution({ hostId: 'local', command: source.includes(process.execPath) ? source : nodeCommand(source), cwd, requested: { network: false, externalWrite: false, destructive: false, credentials: false, admin: false, unknownRisk: false } });
}
function nodeCommand(source: string): string { return [process.execPath, '-e', source].map(value => `"${value.replaceAll('"', '\\"')}"`).join(' '); }
async function delay(ms: number): Promise<void> { await new Promise(resolve => setTimeout(resolve, ms)); }
