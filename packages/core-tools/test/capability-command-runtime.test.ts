import { access, copyFile, mkdir, mkdtemp, readFile, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PreparedToolIntent, ToolExecuteContext, ToolPrepareContext } from '@dbagent/core-agent';
import { CapabilityCommandRuntime, PathExecutableDiscovery, ProcessRuntime, prepareProcessPath, type CapabilityCommandInput, type ExecutableLaunchDescriptor, type ProcessArgvPolicyInput, type ProcessRuntimeOptions } from '../src/index.js';
import { CommandRedactor } from '../src/command-redaction.js';

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

  it('keeps legacy shell policy unchanged and fails argv closed until its own hook is configured', async () => {
    const allowCommand = vi.fn((_command: string) => true);
    const f = await fixture({ globalPolicy: { revision: 'host.v2', mode: 'default', allowCommand } });
    await f.runtime.prepareExecution({ hostId: 'local', cwd: f.root, command: 'echo ordinary', requested });
    expect(allowCommand).toHaveBeenLastCalledWith('echo ordinary');
    await expect(f.port.prepare(f.input(['-e', 'process.exit(0)']), f.context)).rejects.toThrow('policy rejects');
    expect(allowCommand).toHaveBeenCalledTimes(1);
  });

  it('applies explainable argv allowlists and git push denies independently of executable upgrades', async () => {
    const allowArgv = vi.fn((input: ProcessArgvPolicyInput) => input.cli === 'git' && input.argv[0] === 'status');
    const f = await fixture({ globalPolicy: { revision: 'host.v3', mode: 'full-access', allowArgv } });
    const filename = process.platform === 'win32' ? 'git.exe' : 'git';
    const path = join(f.root, filename);
    await copyFile(process.execPath, path);
    const discovery = new PathExecutableDiscovery({ PATH: f.root });
    const first = await discovery.discover('git'); if (first.status !== 'available') throw new Error('Fixture CLI unavailable.');
    await expect(f.port.prepare(f.input(['push', 'origin'], first.launch), f.context)).rejects.toThrow('policy rejects');
    await f.port.prepare(f.input(['status', '--porcelain'], first.launch), f.context);
    const before = allowArgv.mock.calls.at(-1)?.[0];
    expect(before).toEqual({ cli: 'git', argv: ['status', '--porcelain'] });
    expect(Object.isFrozen(before)).toBe(true); expect(Object.isFrozen(before?.argv)).toBe(true);
    await utimes(path, new Date(), new Date(Date.now() + 5000));
    const updated = await discovery.discover('git'); if (updated.status !== 'available') throw new Error('Updated CLI unavailable.');
    expect(updated.launch.executable.mtimeNs === first.launch.executable.mtimeNs).toBe(false);
    await f.port.prepare(f.input(['status', '--porcelain'], updated.launch), f.context);
    expect(allowArgv.mock.calls.at(-1)?.[0]).toEqual(before);
    await expect(f.port.prepare(f.input(['status'], f.executable), f.context)).rejects.toThrow('policy rejects');
  });

  it('rejects NUL and explicit secrets without echoing arguments', async () => {
    const f = await fixture({ environment: { ...process.env, TEST_API_KEY: 'dummy-private-command-value' } });
    for (const args of [['a\0b'], ['--token', 'dummy-private-command-value'], ['dummy-private-command-value']]) {
      let rejected = false; let diagnostic = '';
      try { await f.port.prepare(f.input(args), f.context); }
      catch (error) { rejected = true; diagnostic = error instanceof Error ? error.message : ''; }
      expect(rejected).toBe(true);
      expect(diagnostic.includes('dummy-private-command-value')).toBe(false);
    }
  });

  it('bounds projections and redacts split secrets before spool persistence and retention', async () => {
    const secret = 'dummy-private-command-value';
    const f = await fixture({ maxProjectionBytes: 64, environment: { ...process.env, TEST_API_KEY: secret } });
    const source = 'process.stdout.write(process.env.TEST_API_KEY.slice(0, 8)); setTimeout(() => { process.stdout.write(process.env.TEST_API_KEY.slice(8)); process.stdout.write("x".repeat(5000)); }, 10)';
    const intent = await f.port.prepare(f.input(['-e', source]), f.context);
    const result = await f.port.execute(intent.input, f.execution(intent)) as { process: { processId: string; output: { stdout: { truncated: boolean } } }; spool: { stdout: { text: string } } };
    expect(result.process.output.stdout.truncated).toBe(true);
    expect(result.spool.stdout.text.startsWith('*')).toBe(true);
    expect(result.spool.stdout.text.length).toBeGreaterThan(5000);
    expect(JSON.stringify(result).includes(secret)).toBe(false);
    expect((await readFile(join(f.root, '.spool', result.process.processId, 'stdout.log'), 'utf8')).includes(secret)).toBe(false);
  });

  it('does not start after an expired deadline', async () => {
    const f = await fixture();
    const intent = await f.port.prepare(f.input(['-e', 'process.exit(0)']), f.context);
    await expect(f.port.execute(intent.input, f.execution(intent, { deadline: new Date(0).toISOString() }))).rejects.toThrow('deadline expired');
  });

  it('redacts quoted credentials in real command output before payload and spool retention', async () => {
    const f = await fixture();
    const secret = 'dummy-quoted-credential-value';
    const original = [JSON.stringify({ password: secret, nested: { token: secret } }), "{'password':'" + secret + "'}", 'password="' + secret + '"', "token='" + secret + "'", 'api_key=' + secret, 'Bearer ' + secret, 'https://user:' + secret + '@example.test/path'].join('\n');
    const inputPath = join(f.root, 'input.txt'); await writeFile(inputPath, original);
    const intent = await f.port.prepare(f.input(['-e', 'process.stdout.write(require("node:fs").readFileSync(process.argv[1]))', inputPath]), f.context);
    const result = await f.port.execute(intent.input, f.execution(intent)) as { process: { processId: string }; spool: { stdout: { text: string } } };
    const stored = await readFile(join(f.root, '.spool', result.process.processId, 'stdout.log'), 'utf8');
    // Boolean assertions ensure a redaction regression never prints credential text.
    expect(JSON.stringify(result).includes(secret)).toBe(false); expect(stored.includes(secret)).toBe(false);
    expect(Buffer.byteLength(stored)).toBeLessThanOrEqual(Buffer.byteLength(original));
    expect(JSON.parse(result.spool.stdout.text.split('\n')[0]!)).toEqual({ password: '*', nested: { token: '*' } });
    for (const value of original.split('\n')) {
      let rejected = false;
      try { await f.port.prepare(f.input([value]), f.context); } catch { rejected = true; }
      expect(rejected).toBe(true);
    }
  });

  it('masks complete authentication headers and structured values in real payloads and both spools', async () => {
    const f = await fixture();
    const secret = 'dummy-auth-header-value';
    const basic = Buffer.from('fixture-user:' + secret).toString('base64');
    const suffix = 'dummy-auth-tail-value';
    const original = [
      'Authorization: Basic ' + basic,
      'Proxy-Authorization: token ' + secret,
      'Authorization=Custom-Scheme ' + secret + ' ' + suffix,
      'Proxy-Authorization: "Basic ' + basic + '"',
      "Authorization: 'Custom-Scheme " + secret + "'",
      'Authorization: Basic "' + secret + ',' + suffix + '"',
      JSON.stringify({ Authorization: 'Basic ' + basic, safe: 'preserved' }),
      "{'Proxy-Authorization':'token " + secret + "','safe':'preserved'}",
      'X-Public: preserved',
      '{\n"Authorization"\n:\n"Basic ' + basic + '"\n}',
    ].join('\n');
    const path = join(f.root, 'authentication.txt'); await writeFile(path, original);
    const intent = await f.port.prepare(f.input(['-e', 'const data = require("node:fs").readFileSync(process.argv[1]); process.stdout.write(data); process.stderr.write(data);', path]), f.context);
    const result = await f.port.execute(intent.input, f.execution(intent)) as { process: { processId: string }; spool: { stdout: { text: string } } };
    const stored = await Promise.all(['stdout.log', 'stderr.log'].map(file => readFile(join(f.root, '.spool', result.process.processId, file), 'utf8')));
    for (const value of [secret, basic, suffix]) {
      expect(JSON.stringify(result).includes(value)).toBe(false);
      expect(stored.some(output => output.includes(value))).toBe(false);
    }
    for (const output of stored) {
      expect(Buffer.byteLength(output)).toBeLessThanOrEqual(Buffer.byteLength(original));
      expect(output.includes('X-Public: preserved')).toBe(true);
      expect(JSON.parse(output.split('\n')[6]!)).toEqual({ Authorization: '*', safe: 'preserved' });
    }
  });

  it('rejects split and assigned long credential flags before an intent or policy input exists', async () => {
    const allowArgv = vi.fn(() => true);
    const f = await fixture({ globalPolicy: { mode: 'full-access', revision: 'credential-flags.v1', allowArgv } });
    const secret = 'dummy-split-flag-value';
    for (const flag of ['--access-token', '--refresh-token', '--session-token', '--credentials', '--connection-string', '--database-url', '--db-url', '--dsn', '--proxy-authorization', '--authorization', '--api-key', '--passwd', '--pwd', '--credential', '--password', '--secret', '--token']) {
      for (const argv of [[flag, secret], [flag + '=' + secret]]) {
        let rejected = false; let diagnostic = '';
        try { await f.port.prepare(f.input(argv), f.context); }
        catch (error) { rejected = true; diagnostic = error instanceof Error ? error.message : ''; }
        expect(rejected).toBe(true); expect(diagnostic.includes(secret)).toBe(false);
      }
    }
    expect(allowArgv).toHaveBeenCalledTimes(0);
    await expect(f.port.prepare(f.input(['-p', '5432']), f.context)).resolves.toBeDefined();
    expect(allowArgv).toHaveBeenCalledTimes(1);
    await expect(access(join(f.root, '.spool'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([16, 8 * 1024 * 1024])('never expands repeated short environment secrets at %i raw bytes', async size => {
    const environment = { ...process.env, ...Object.fromEntries(Array.from({ length: 12 }, (_, index) => ['TOKEN_' + index, 'E'])) };
    const f = await fixture({ environment });
    const path = join(f.root, 'emit.cjs'); await writeFile(path, 'process.stdout.write("E".repeat(' + size + '))');
    const intent = await f.port.prepare(f.input([path]), f.context);
    const result = await f.port.execute(intent.input, f.execution(intent)) as { status: string; process: { processId: string }; spool: { stdout: { text: string } } };
    const stored = await readFile(join(f.root, '.spool', result.process.processId, 'stdout.log'), 'utf8');
    expect(result.status).toBe('ok');
    expect(stored.includes('E')).toBe(false); expect(stored).toBe('*');
    expect(Buffer.byteLength(result.spool.stdout.text)).toBeLessThanOrEqual(size);
  }, 20_000);

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

  it.skipIf(process.platform !== 'win32').each([
    ['npm-else.cmd', 'node_modules/npm/bin/npx-cli.js'],
    ['npm-final.cmd', 'node_modules/@nwlworkshop/schemanaut/dist/server/cli.js'],
  ])('resolves the captured %s npm layout with spaces and Unicode', async (sample, entry) => {
    const f = await fixture();
    const root = join(f.root, '含 空格'); await mkdir(root);
    const script = join(root, entry); await mkdir(dirname(script), { recursive: true }); await writeFile(script, 'process.stdout.write("shim executed")');
    await copyFile(new URL('./fixtures/command-shims/' + sample, import.meta.url), join(root, 'safe.cmd'));
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

  it.skipIf(process.platform !== 'win32')('resolves the captured pnpm wrapper and rejects traversal, extra commands and inconsistent branches', async () => {
    const f = await fixture();
    const modules = join(f.root, 'node_modules'); const bin = join(modules, '.bin');
    await mkdir(bin, { recursive: true });
    const script = join(modules, 'typescript/bin/tsc'); await mkdir(dirname(script), { recursive: true });
    await writeFile(script, 'process.stdout.write(process.env.NODE_PATH || "missing")');
    const sample = (await readFile(new URL('./fixtures/command-shims/pnpm-tsc.cmd', import.meta.url), 'utf8')).replaceAll('C:\\fixture', f.root);
    const path = join(bin, 'tsc.cmd'); await writeFile(path, sample);
    const discovery = new PathExecutableDiscovery({ PATH: bin + ';' + dirname(process.execPath) });
    const found = await discovery.discover('tsc'); if (found.status !== 'available') throw new Error('Captured pnpm launcher unavailable.');
    const intent = await f.port.prepare(f.input([], found.launch), f.context);
    const result = await f.port.execute(intent.input, f.execution(intent)) as { spool: { stdout: { text: string } } };
    expect(result.spool.stdout.text.startsWith(found.launch.nodePath.join(';'))).toBe(true);
    for (const malicious of [
      sample + '\necho injected\n',
      sample.replaceAll('..\\typescript\\bin\\tsc', '..\\..\\outside.js'),
      sample.replaceAll('..\\typescript\\bin\\tsc', '..\\typescript\\..\\outside.js'),
      sample.replace('node  "%~dp0\\..\\typescript\\bin\\tsc"', 'node  "%~dp0\\..\\typescript\\bin\\other.js"'),
      sample.replace('@SETLOCAL', '@SETLOCAL & echo injected'),
      sample.replace('@SET "NODE_PATH=', '@SET "NODE_PATH=& echo injected&'),
    ]) {
      await writeFile(path, malicious);
      expect((await discovery.discover('tsc')).status).toBe('unavailable');
    }
  });

  it.skipIf(process.platform !== 'win32')('discovers and launches the installed workspace pnpm TypeScript shim without batch execution', async () => {
    const f = await fixture();
    const discovery = new PathExecutableDiscovery({ PATH: resolve('../../node_modules/.bin') + ';' + dirname(process.execPath) });
    const found = await discovery.discover('tsc'); if (found.status !== 'available') throw new Error('Installed workspace TypeScript unavailable.');
    const intent = await f.port.prepare(f.input(['--version'], found.launch), f.context);
    await expect(f.port.execute(intent.input, f.execution(intent))).resolves.toMatchObject({ status: 'ok', spool: { stdout: { text: expect.stringMatching(/^Version \d/u) } } });
  });
});

describe('nonexpanding command redaction', () => {
  it('bounds a maximum-sized quoted credential without regex-stack or output growth', () => {
    const prefix = '{"password":"'; const suffix = '"}';
    const input = prefix + 'x'.repeat(8 * 1024 * 1024 - prefix.length - suffix.length) + suffix;
    const result = new CommandRedactor({}).redact(input);
    expect(result.changed).toBe(true); expect(result.text).toBe('{"password":"*"}');
  });

  it('handles overlapping duplicate short secrets, quoted JSON and marker-like values from original text', () => {
    const redactor = new CommandRedactor({ TOKEN_1: 'E', TOKEN_2: 'E', TOKEN_3: '[REDACTED]', TOKEN_4: '*' });
    const input = 'E'.repeat(16) + ' [REDACTED] * ' + JSON.stringify({ password: 'dummy-secret' });
    const result = redactor.redact(input);
    expect(result.changed).toBe(true);
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(Buffer.byteLength(input));
    expect(result.text.includes('dummy-secret')).toBe(false);
  });
});
