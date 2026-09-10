import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PreparedToolIntent, ToolExecuteContext, ToolPrepareContext } from '@dbagent/core-agent';
import { CapabilityCommandRuntime, PathExecutableDiscovery, ProcessRuntime, prepareProcessPath, type CapabilityCommandInput, type ExecutableLaunchDescriptor, type ProcessRuntimeOptions } from '../src/index.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.allSettled(cleanups.splice(0).map(cleanup => cleanup())); });
const requested = { network: false, externalWrite: false, destructive: false, credentials: false, admin: false, unknownRisk: false };
const owner = { hostId: 'local', sessionId: 'session-command', runId: 'run-command' };
const signal = () => new AbortController().signal;

async function fixture(options: Partial<ProcessRuntimeOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'nexus-command-'));
  const runtime = new ProcessRuntime({ spoolDirectory: join(root, '.spool'), ...options });
  cleanups.push(async () => { try { await runtime.close(); } finally { await rm(root, { force: true, recursive: true }); } });
  const port = new CapabilityCommandRuntime(runtime);
  const found = await new PathExecutableDiscovery({ PATH: dirname(process.execPath) }).discover(basename(process.execPath).replace(/\.exe$/iu, ''));
  if (found.status !== 'available') throw new Error('Test Node executable is unavailable.');
  const context = { ...owner, projectId: 'project-command', turnId: 'turn-command', invocationId: 'inv-command', idempotencyKey: 'command-key', signal: signal(), generation: '1', runPolicy: { mode: 'full-access', revision: 'actual-run-policy.v3' }, descriptor: { flatName: 'test_command' }, toolRevision: 'test.v1', handlerRevision: 'test.handler.v1', intentRevision: 'prepared-tool-intent.v1', limits: { timeoutMs: 20_000, maxInputBytes: 262_144, maxOutputBytes: 65_536, maxArtifactBytes: 16_777_216, maxDepth: 20, maxRecords: 2000 } } as ToolPrepareContext;
  const input = (argv: readonly string[], executable: ExecutableLaunchDescriptor = found.launch): CapabilityCommandInput => ({ executable, argv, cwd: root, pathTargets: [], hostTargets: [], requested, permission: { access: 'read', recoveryClass: 'read', dangerLevel: 'safe', actions: ['read', 'execute'] }, resourceKeys: ['workspace:' + root] });
  const execution = (intent: PreparedToolIntent, overrides: object = {}): ToolExecuteContext => ({ ...context, intent, deadline: new Date(Date.now() + 20_000).toISOString(), authorization: { policyMode: context.runPolicy.mode, policyRevision: context.runPolicy.revision, policyDecision: 'allow' }, ...overrides } as unknown as ToolExecuteContext);
  return { root, runtime, port, context, input, execution, executable: found.launch };
}

describe('Capability command Host port', () => {
  it('launches literal argv including shell metacharacters, spaces, quotes, Unicode and controls', async () => {
    const f = await fixture();
    const args = ['space value', '中文路径', '"quoted"', "'single'", '& echo INJECTED > side-effect', '$(whoami)', '`x`', 'line\nbreak\tend'];
    const intent = await f.port.prepare(f.input(['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', '--', ...args]), f.context);
    expect(intent).toMatchObject({ runPolicy: f.context.runPolicy, targetIdentity: { kind: 'process-exec', plan: { launch: { kind: 'argv', argv: expect.any(Array) }, boundary: { mode: 'full-access', policyRevision: 'actual-run-policy.v3' } } } });
    const result = await f.port.execute(intent.input, f.execution(intent)) as { spool: { stdout: { text: string } }; process: { exitCode: number; treeStopped: boolean; treeStopProof: string } };
    expect(JSON.parse(result.spool.stdout.text)).toEqual(args);
    expect(result.process).toMatchObject({ exitCode: 0, treeStopProof: process.platform === 'win32' ? 'unverified' : 'verified', treeStopped: process.platform !== 'win32' });
    await expect(access(join(f.root, 'side-effect'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses the real Run policy, enforces unsandboxed approval and checks policy revision', async () => {
    const f = await fixture();
    const context = { ...f.context, runPolicy: { mode: 'auto' as const, revision: 'enterprise.v7' } };
    const intent = await f.port.prepare(f.input(['-e', 'process.exit(0)']), context);
    expect(intent.permission.unknownRisk).toBe(true);
    expect(intent.targetIdentity).toMatchObject({ plan: { boundary: { mode: 'auto', policyRevision: 'enterprise.v7', decision: 'ask-unsandboxed' } } });
    await expect(f.port.execute(intent.input, f.execution(intent))).rejects.toMatchObject({ fact: { code: 'target_changed' } });
    const current = { policyMode: 'auto', policyRevision: 'enterprise.v7', policyDecision: 'ask' };
    await expect(f.port.execute(intent.input, f.execution(intent, { authorization: current }))).rejects.toThrow('requires explicit approval');
    await expect(f.port.execute(intent.input, f.execution(intent, { authorization: { ...current, approvalId: 'approved' } }))).resolves.toMatchObject({ status: 'ok', executionBoundary: { enforcement: 'native' } });
  });

  it('returns unavailable under enterprise requireSandbox without spawning', async () => {
    const f = await fixture({ globalPolicy: { revision: 'host-policy.v1', mode: 'full-access', requireSandbox: true } });
    const intent = await f.port.prepare(f.input(['-e', 'process.exit(0)']), f.context);
    await expect(f.port.execute(intent.input, f.execution(intent))).resolves.toMatchObject({ status: 'unavailable', reason: 'required_sandbox_unavailable' });
    await expect(access(join(f.root, '.spool'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('checks real file targets again and never performs the action after replacement', async () => {
    const f = await fixture();
    const path = join(f.root, 'target.txt');
    await writeFile(path, 'original');
    const intent = await f.port.prepare({ ...f.input(['-e', 'process.exit(0)']), pathTargets: [await prepareProcessPath(path, f.root)] }, f.context);
    expect(intent.permission.paths).toContain(path);
    await rename(path, path + '.old'); await writeFile(path, 'replacement');
    await expect(f.port.execute(intent.input, f.execution(intent))).rejects.toMatchObject({ fact: { code: 'target_changed' } });
  });

  it('keeps shell policy input unchanged and gives argv policy an opaque stable identity', async () => {
    const allowCommand = vi.fn((_command: string) => true);
    const f = await fixture({ globalPolicy: { revision: 'host.v2', mode: 'default', allowCommand } });
    await f.runtime.prepareExecution({ hostId: 'local', cwd: f.root, command: 'echo ordinary', requested });
    expect(allowCommand).toHaveBeenLastCalledWith('echo ordinary');
    await f.port.prepare(f.input(['-e', 'process.exit(0)']), f.context);
    const key = allowCommand.mock.calls.at(-1)?.[0];
    expect(key).toMatch(/^argv-sha256:[a-f0-9]{64}$/u);
    await f.port.prepare(f.input(['-e', 'process.exit(0)']), f.context);
    expect(allowCommand).toHaveBeenLastCalledWith(key);
  });

  it('rejects NUL and explicit secrets without echoing arguments', async () => {
    const f = await fixture({ environment: { ...process.env, TEST_API_KEY: 'dummy-private-command-value' } });
    for (const args of [['a\0b'], ['--token', 'dummy-private-command-value'], ['dummy-private-command-value']]) {
      await expect(f.port.prepare(f.input(args), f.context)).rejects.toThrow();
    }
  });

  it('bounds projections and redacts split secrets before spool persistence and retention', async () => {
    const secret = 'dummy-private-command-value';
    const f = await fixture({ maxProjectionBytes: 64, environment: { ...process.env, TEST_API_KEY: secret } });
    const source = 'process.stdout.write(process.env.TEST_API_KEY.slice(0, 8)); setTimeout(() => { process.stdout.write(process.env.TEST_API_KEY.slice(8)); process.stdout.write("x".repeat(5000)); }, 10)';
    const intent = await f.port.prepare(f.input(['-e', source]), f.context);
    const result = await f.port.execute(intent.input, f.execution(intent)) as { process: { processId: string; output: { stdout: { truncated: boolean } } }; spool: { stdout: { text: string } } };
    expect(result.process.output.stdout.truncated).toBe(true);
    expect(result.spool.stdout.text).toContain('[REDACTED]');
    expect(result.spool.stdout.text.length).toBeGreaterThan(5000);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(await readFile(join(f.root, '.spool', result.process.processId, 'stdout.log'), 'utf8')).not.toContain(secret);
  });

  it('does not start after an expired deadline', async () => {
    const f = await fixture();
    const intent = await f.port.prepare(f.input(['-e', 'process.exit(0)']), f.context);
    await expect(f.port.execute(intent.input, f.execution(intent, { deadline: new Date(0).toISOString() }))).rejects.toThrow('deadline expired');
  });

  it.skipIf(process.platform !== 'win32')('retains unknown outcome on native Windows cancellation', async () => {
    const f = await fixture();
    const intent = await f.port.prepare(f.input(['-e', 'setTimeout(() => {}, 10000)']), f.context);
    const controller = new AbortController();
    const execution = f.port.execute(intent.input, f.execution(intent, { signal: controller.signal }));
    const timer = setTimeout(() => controller.abort(), 150);
    try { await expect(execution).rejects.toMatchObject({ fact: { outcome: 'unknown' } }); } finally { clearTimeout(timer); }
  }, 15_000);
});

describe('static PATH discovery', () => {
  it('captures the startup PATH and returns only bounded diagnostics for unsafe names', async () => {
    const environment = { PATH: dirname(process.execPath) };
    const discovery = new PathExecutableDiscovery(environment);
    environment.PATH = 'changed';
    expect(await discovery.discover(basename(process.execPath).replace(/\.exe$/iu, ''))).toMatchObject({ status: 'available' });
    const failure = await discovery.discover('node; malicious');
    expect(failure).toMatchObject({ status: 'unavailable' });
    expect(JSON.stringify(failure)).not.toContain(dirname(process.execPath));
    expect(JSON.stringify(failure)).not.toContain('malicious');
  });

  it.skipIf(process.platform !== 'win32')('safely resolves the exact npm Node shim with spaces and Unicode and rejects custom batch', async () => {
    const f = await fixture();
    const root = join(f.root, '含 空格'); await mkdir(root);
    const script = join(root, 'entry 文件.js'); await writeFile(script, 'process.stdout.write("shim executed")');
    const prefix = '@ECHO off\nGOTO start\n:find_dp0\nSET dp0=%~dp0\nEXIT /b\n:start\nSETLOCAL\nCALL :find_dp0\n\nIF EXIST "%dp0%\\node.exe" (\n  SET "_prog=%dp0%\\node.exe"\n) ELSE (\n  SET "_prog=node"\n  SET PATHEXT=%PATHEXT:;.JS;=;%\n)\n\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\';
    await writeFile(join(root, 'safe.cmd'), prefix + 'entry 文件.js" %*\n');
    await writeFile(join(root, 'unsafe.cmd'), '@echo off\necho injected\n');
    const discovery = new PathExecutableDiscovery({ PATH: root + ';' + dirname(process.execPath) });
    const found = await discovery.discover('safe');
    expect(found.status).toBe('available'); if (found.status !== 'available') return;
    const intent = await f.port.prepare(f.input([], found.launch), f.context);
    await expect(f.port.execute(intent.input, f.execution(intent))).resolves.toMatchObject({ spool: { stdout: { text: 'shim executed' } } });
    const second = await f.port.prepare(f.input([], found.launch), f.context);
    await writeFile(script, 'process.stdout.write("changed")');
    await expect(f.port.execute(second.input, f.execution(second))).rejects.toMatchObject({ fact: { code: 'target_changed' } });
    expect(await discovery.discover('unsafe')).toMatchObject({ status: 'unavailable', reason: 'unsupported_launcher' });
  });
});
