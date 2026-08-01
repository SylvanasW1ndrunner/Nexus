import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProcessRuntime } from '../src/index.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('ProcessRuntime', () => {
  it('executes a foreground command and keeps a bounded head/tail projection', async () => {
    const fixture = await runtimeFixture({ maxProjectionBytes: 80 });
    const command = nodeCommand(
      `process.stdout.write('HEAD-' + 'x'.repeat(200) + '-TAIL'); process.stderr.write('warning');`,
    );

    const result = await fixture.runtime.exec({
      sessionId: 'session-a',
      command,
      cwd: fixture.root,
      timeoutMs: 5_000,
    });

    expect(result).toMatchObject({
      status: 'exited',
      exitCode: 0,
      timedOut: false,
    });
    expect(result.output.stdout.text).toContain('HEAD-');
    expect(result.output.stdout.text).toContain('-TAIL');
    expect(result.output.stdout.truncated).toBe(true);
    expect(result.output.stderr.text).toBe('warning');
    expect(result.nextCursor.stdoutBytes).toBeGreaterThan(200);
  });

  it('supports background poll, stdin, and session-bound handles', async () => {
    const fixture = await runtimeFixture();
    const script = [
      "process.stdin.setEncoding('utf8');",
      "process.stdout.write('ready\\n');",
      "process.stdin.once('data', value => { process.stdout.write('echo:' + value); process.exit(0); });",
    ].join(' ');
    const started = await fixture.runtime.exec({
      sessionId: 'session-a',
      command: nodeCommand(script),
      cwd: fixture.root,
      background: true,
      timeoutMs: 5_000,
    });

    expect(started.status).toBe('running');
    await expect(
      fixture.runtime.poll({
        sessionId: 'session-b',
        processId: started.processId,
      }),
    ).rejects.toThrow('current Session');

    const ready = await waitForOutput(fixture.runtime, 'session-a', started.processId, 'ready');
    await fixture.runtime.write({
      sessionId: 'session-a',
      processId: started.processId,
      input: 'hello',
      end: true,
    });
    const finished = await waitForTerminal(
      fixture.runtime,
      'session-a',
      started.processId,
      ready.nextCursor,
    );

    expect(finished.status).toBe('exited');
    expect(finished.exitCode).toBe(0);
    expect(finished.output.stdout.text).toContain('echo:hello');
  });

  it('times out and removes the complete descendant process tree', async () => {
    const fixture = await runtimeFixture();
    const tree = await processTreeFixture(fixture.root, 1_400);

    const result = await fixture.runtime.exec({
      sessionId: 'session-timeout',
      command: fileCommand(tree.parentScript, tree.childScript, tree.markerPath, tree.readyPath, '1400'),
      cwd: fixture.root,
      timeoutMs: 350,
    });

    expect(result.status).toBe('timed-out');
    expect(result.timedOut).toBe(true);
    await delay(1_700);
    await expect(access(tree.markerPath)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 10_000);

  it('terminates background descendants and reacts to parent cancellation', async () => {
    const fixture = await runtimeFixture();
    const explicitTree = await processTreeFixture(fixture.root, 1_500, 'explicit');
    const started = await fixture.runtime.exec({
      sessionId: 'session-stop',
      command: fileCommand(
        explicitTree.parentScript,
        explicitTree.childScript,
        explicitTree.markerPath,
        explicitTree.readyPath,
        '1500',
      ),
      cwd: fixture.root,
      background: true,
      timeoutMs: 5_000,
    });
    await waitForPath(explicitTree.readyPath);
    const stopped = await fixture.runtime.terminate({
      sessionId: 'session-stop',
      processId: started.processId,
    });
    expect(stopped.status).toBe('terminated');

    const abortTree = await processTreeFixture(fixture.root, 1_500, 'abort');
    const controller = new AbortController();
    const aborted = await fixture.runtime.exec({
      sessionId: 'session-abort',
      command: fileCommand(
        abortTree.parentScript,
        abortTree.childScript,
        abortTree.markerPath,
        abortTree.readyPath,
        '1500',
      ),
      cwd: fixture.root,
      background: true,
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    await waitForPath(abortTree.readyPath);
    controller.abort();
    const abortedResult = await waitForTerminal(
      fixture.runtime,
      'session-abort',
      aborted.processId,
    );
    expect(abortedResult.status).toBe('terminated');

    await delay(1_800);
    await expect(access(explicitTree.markerPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(abortTree.markerPath)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 15_000);
});

async function runtimeFixture(options: { maxProjectionBytes?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'schemanaut-process-runtime-'));
  const runtime = new ProcessRuntime({
    spoolDirectory: join(root, '.process-spool'),
    maxProjectionBytes: options.maxProjectionBytes ?? 4_096,
    retentionMs: 60_000,
  });
  cleanups.push(async () => {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, runtime };
}

async function waitForOutput(
  runtime: ProcessRuntime,
  sessionId: string,
  processId: string,
  expected: string,
) {
  const deadline = Date.now() + 5_000;
  let cursor = { stdoutBytes: 0, stderrBytes: 0 };
  while (Date.now() < deadline) {
    const result = await runtime.poll({ sessionId, processId, cursor, waitMs: 100 });
    if (result.output.stdout.text.includes(expected)) return result;
    cursor = result.nextCursor;
  }
  throw new Error(`Timed out waiting for process output: ${expected}`);
}

async function waitForTerminal(
  runtime: ProcessRuntime,
  sessionId: string,
  processId: string,
  cursor = { stdoutBytes: 0, stderrBytes: 0 },
) {
  const deadline = Date.now() + 5_000;
  let currentCursor = cursor;
  let stdout = '';
  let stderr = '';
  while (Date.now() < deadline) {
    const result = await runtime.poll({
      sessionId,
      processId,
      cursor: currentCursor,
      waitMs: 100,
    });
    stdout += result.output.stdout.text;
    stderr += result.output.stderr.text;
    if (result.status !== 'running') {
      return {
        ...result,
        output: {
          stdout: { ...result.output.stdout, text: stdout },
          stderr: { ...result.output.stderr, text: stderr },
        },
      };
    }
    currentCursor = result.nextCursor;
  }
  throw new Error('Timed out waiting for process termination.');
}

function nodeCommand(source: string): string {
  return [process.execPath, '-e', source]
    .map((value) => `"${value.replaceAll('"', '\\"')}"`)
    .join(' ');
}

function fileCommand(scriptPath: string, ...args: string[]): string {
  return [process.execPath, scriptPath, ...args]
    .map((value) => `"${value.replaceAll('"', '\\"')}"`)
    .join(' ');
}

async function processTreeFixture(
  directory: string,
  delayMs: number,
  suffix = 'timeout',
): Promise<{
  parentScript: string;
  childScript: string;
  markerPath: string;
  readyPath: string;
}> {
  const parentScript = join(directory, `parent-${suffix}.mjs`);
  const childScript = join(directory, `child-${suffix}.mjs`);
  const markerPath = join(directory, `marker-${suffix}.txt`);
  const readyPath = join(directory, `ready-${suffix}.txt`);
  await writeFile(
    childScript,
    [
      "import { writeFileSync } from 'node:fs';",
      'const delayMs = Number(process.argv[3]);',
      "setTimeout(() => writeFileSync(process.argv[2], 'leaked'), delayMs);",
      'setTimeout(() => process.exit(0), delayMs + 500);',
    ].join('\n'),
    'utf8',
  );
  await writeFile(
    parentScript,
    [
      "import { spawn } from 'node:child_process';",
      "import { writeFileSync } from 'node:fs';",
      'const child = spawn(process.execPath, [process.argv[2], process.argv[3], process.argv[5]], { stdio: \'ignore\' });',
      "writeFileSync(process.argv[4], String(child.pid ?? 'missing'));",
      'setTimeout(() => process.exit(0), Number(process.argv[5]) + 750);',
    ].join('\n'),
    'utf8',
  );
  return { parentScript, childScript, markerPath, readyPath };
}

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${path}.`);
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
