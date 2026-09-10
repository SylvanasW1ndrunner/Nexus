import { randomUUID } from 'node:crypto';
import type { RunPolicySnapshot } from '@dbagent/core-agent';
import { executablePolicyName, validateExecutableDescriptor } from './executable-discovery.js';
import { CommandArgumentGuard, CommandRedactor } from './command-redaction.js';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { constants } from 'node:fs';
import { appendFile, lstat, mkdir, open, opendir, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { inheritedProcessEnvironment, NativeSandboxExecutor, prepareSandboxBoundary, type PreparedSandboxBoundary, type ProcessGlobalPolicy, type ProcessRequestedCapabilities, type SandboxExecutor, type ProcessLaunch } from './sandbox-executor.js';

const PROCESS_TREE_KILL_GRACE_MS = 250;
const PROCESS_CLOSE_GRACE_MS = 2_000;

export type ProcessRuntimeStatus = 'running' | 'exited' | 'failed' | 'timed_out' | 'terminated' | 'orphaned' | 'unknown';
export class ProcessRuntimeError extends Error {
  constructor(readonly kind: 'not_found' | 'precondition' | 'invalid_cursor' | 'invalid_argument' | 'external' | 'limit' | 'timeout' | 'cancelled' | 'target_changed', message: string, readonly outcome: 'not_applied' | 'unknown' = 'not_applied') { super(message); this.name = 'ProcessRuntimeError'; }
}
export type ProcessOwner = { hostId: string; sessionId: string; runId: string };
export type ProcessOutputCursor = { processId: string; stdoutBytes: number; stderrBytes: number };
export type ProcessOutputProjection = { text: string; encoding: 'utf-8' | 'base64'; fromByte: number; toByte: number; totalBytes: number; truncated: boolean };
export type ProcessRuntimeSnapshot = {
  processId: string; pid?: number; status: ProcessRuntimeStatus; exitCode: number | null; signal: NodeJS.Signals | null;
  timedOut: boolean; startedAt: string; finishedAt?: string; expiresAt?: string;
  output: { stdout: ProcessOutputProjection; stderr: ProcessOutputProjection }; nextCursor: ProcessOutputCursor;
  outputComplete: boolean; outputReadable: boolean; treeStopped: boolean; treeStopProof: 'verified' | 'unverified'; error?: string;
};
export type PreparedProcessExecution = {
  boundary: PreparedSandboxBoundary; cwd: string; cwdIdentity: { dev: string; ino: string };
  launch: ProcessLaunch;
  hostPolicyRevision: string;
  runtimeLimits: ProcessRuntimeLimits;
  pathTargets: readonly ProcessPathTarget[];
  hostTargets: readonly string[];
};
export type ProcessPathTarget = Readonly<{ requestedPath: string; canonicalPath: string; identityPath: string; identity: { dev: string; ino: string } }>;
export type PreparedProcessTarget = { kind: 'process-exec'; plan: PreparedProcessExecution } | {
  kind: 'process-control'; owner: ProcessOwner; processId: string; runtimeId: string; runtimeLimits: ProcessRuntimeLimits; action: 'poll' | 'write' | 'terminate';
};
export type ProcessRuntimeOptions = {
  spoolDirectory: string; hostId?: string; executor?: SandboxExecutor; globalPolicy?: ProcessGlobalPolicy;
  defaultTimeoutMs?: number; maxProjectionBytes?: number; retentionMs?: number; environment?: NodeJS.ProcessEnv;
  maxProcesses?: number; maxProcessesPerRun?: number; maxProcessSpoolBytes?: number; maxRunSpoolBytes?: number;
  maxRunTimeMs?: number; idleTimeoutMs?: number; maxStdinBytes?: number; stdinTimeoutMs?: number;
  now?: () => Date; createProcessId?: () => string;
};
export type ProcessIoContext = { signal: AbortSignal; deadline?: string };
export type ProcessExecInput = ProcessOwner & ProcessIoContext & { prepared: PreparedProcessExecution; background?: boolean; timeoutMs?: number };
export type ProcessPollInput = ProcessOwner & ProcessIoContext & { processId: string; cursor?: ProcessOutputCursor; maxProjectionBytes?: number; waitMs?: number };
export type ProcessWriteInput = ProcessOwner & ProcessIoContext & { processId: string; input: string; end?: boolean; timeoutMs?: number };
export type ProcessTerminateInput = ProcessOwner & ProcessIoContext & { processId: string };
type IoBoundary = { signal: AbortSignal; deadline: number };
export type ProcessCompleteSpool = { stdout: ProcessOutputProjection; stderr: ProcessOutputProjection; outputComplete: boolean; outputReadable: boolean };
type ProcessRecord = {
  processId: string; owner: ProcessOwner; runtimeId: string; child?: ChildProcessWithoutNullStreams; pid?: number;
  directory: string; stdoutPath: string; stderrPath: string; stdoutBytes: number; stderrBytes: number;
  reservedBytes: number; stdoutWrite: Promise<void>; stderrWrite: Promise<void>; metadataWrite: Promise<void>;
  status: ProcessRuntimeStatus; exitCode: number | null; signal: NodeJS.Signals | null; startedAt: string;
  finishedAt?: string; expiresAt?: string; error?: string; outputComplete: boolean; treeStopped: boolean;
  stopReason?: 'timed_out' | 'terminated'; stopPromise?: Promise<void>; terminationFailure?: boolean;
  terminationDrain?: Promise<void>; rootClosed?: boolean;
  confirmationPromise?: Promise<void>; confirmationDrain?: Promise<void>;
  capabilityOutput?: { stdout: Buffer[]; stderr: Buffer[] };
  lifecycle?: Promise<void>; resolveLifecycle?: () => void; exitStatus?: ProcessRuntimeStatus; outputReadable?: boolean; metadataFailed?: boolean;
  timeout?: ReturnType<typeof setTimeout>; idle?: ReturnType<typeof setTimeout>;
  parentSignal?: AbortSignal; abortListener?: () => void; done: Promise<void>; resolveDone: () => void;
  finalized: boolean; revision: number; waiters: Set<() => void>;
};
type StoredProcessMetadata = { version: 1; processId: string; owner: ProcessOwner; runtimeId: string; pid: number | null; status: ProcessRuntimeStatus; exitCode: number | null; signal: NodeJS.Signals | null; startedAt: string; finishedAt: string | null; expiresAt: string | null; outputComplete: boolean; treeStopped: boolean; error: string | null };
export type ProcessRuntimeLimits = Readonly<{ revision: 'process-runtime-limits.v1'; processes: number; perRun: number; processBytes: number; runBytes: number; runMs: number; idleMs: number; stdinBytes: number; stdinMs: number; projectionBytes: number; retentionMs: number; defaultMs: number }>;

/** Run/Host-scoped bounded spools. Restarted live handles are readable orphans, never controllable. */
export class ProcessRuntime {
  private readonly records = new Map<string, ProcessRecord>();
  private readonly runBytes = new Map<string, number>();
  private readonly runtimeId = randomUUID();
  private readonly spoolDirectory: string;
  private readonly executor: SandboxExecutor;
  private readonly policy: ProcessGlobalPolicy;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly commandRedactor: CommandRedactor;
  private readonly commandArgumentGuard: CommandArgumentGuard;
  private readonly now: () => Date;
  private readonly createProcessId: () => string;
  private readonly limits: ProcessRuntimeLimits;
  private readonly operations = new Set<Promise<unknown>>();
  private closeDrain?: Promise<void>;
  private readonly recoveryIssues: string[] = [];
  private isolatedRecords = 0;
  private initialized?: Promise<void>;
  private closeOperation?: Promise<void>;
  private closing = false;
  private reservations = 0;
  private readonly runReservations = new Map<string, number>();

  constructor(options: ProcessRuntimeOptions) {
    this.spoolDirectory = resolve(requiredText(options.spoolDirectory, 'spoolDirectory'));
    this.now = options.now ?? (() => new Date());
    this.createProcessId = options.createProcessId ?? randomUUID;
    this.policy = Object.freeze({ ...(options.globalPolicy ?? { revision: 'process-global-default.v1', mode: 'default' as const }), removeEnvironmentVariables: Object.freeze([...(options.globalPolicy?.removeEnvironmentVariables ?? [])]) });
    this.environment = inheritedProcessEnvironment({ ...(options.environment ?? process.env) }, this.policy);
    this.commandRedactor = new CommandRedactor(this.environment);
    this.commandArgumentGuard = new CommandArgumentGuard(this.environment);
    this.executor = options.executor ?? new NativeSandboxExecutor(options.hostId ?? 'local', async child => {
      await terminateProcessTree(child);
    });
    this.limits = Object.freeze({
      revision: 'process-runtime-limits.v1',
      processes: bounded(options.maxProcesses, 8, 64), perRun: bounded(options.maxProcessesPerRun, 4, 32),
      processBytes: bounded(options.maxProcessSpoolBytes, 8 * 1024 * 1024, 8 * 1024 * 1024),
      runBytes: bounded(options.maxRunSpoolBytes, 64 * 1024 * 1024, 256 * 1024 * 1024),
      runMs: bounded(options.maxRunTimeMs, 30 * 60_000, 86_400_000), idleMs: bounded(options.idleTimeoutMs, 5 * 60_000, 3_600_000),
      stdinBytes: bounded(options.maxStdinBytes, 64 * 1024, 262_144), stdinMs: bounded(options.stdinTimeoutMs, 5_000, 30_000),
      projectionBytes: bounded(options.maxProjectionBytes, 32_768, 262_144), retentionMs: bounded(options.retentionMs, 900_000, 86_400_000),
      defaultMs: bounded(options.defaultTimeoutMs, 60_000, 86_400_000),
    });
  }

  async prepareExecution(input: { hostId: string; command?: string; launch?: ProcessLaunch; runPolicy?: RunPolicySnapshot; cwd: string; requested: ProcessRequestedCapabilities; pathTargets?: readonly ProcessPathTarget[]; hostTargets?: readonly string[] }): Promise<PreparedProcessExecution> {
    this.assertOpen();
    if (input.hostId !== this.executor.identity.hostId) throw new ProcessRuntimeError('target_changed', 'The process executor belongs to another Host.');
    if (input.command !== undefined && input.launch !== undefined) throw new ProcessRuntimeError('invalid_argument', 'Choose exactly one process launch form.');
    const launch: ProcessLaunch = input.launch ? structuredClone(input.launch) : { kind: 'shell', command: requiredText(input.command!, 'command', 16_384) };
    if (launch.kind === 'shell') requiredText(launch.command, 'command', 16_384);
    else if (launch.kind === 'argv') {
      if (!Array.isArray(launch.argv) || launch.argv.length > 256 || launch.argv.some(arg => typeof arg !== 'string' || arg.includes('\0')) || Buffer.byteLength(JSON.stringify(launch.argv)) > 65_536) throw new ProcessRuntimeError('invalid_argument', 'Command arguments exceed the safe launch bounds.');
      if (launch.argv.some(arg => this.commandArgumentGuard.rejects(arg))) throw new ProcessRuntimeError('invalid_argument', 'Credentials must be supplied through the external CLI environment, not command arguments.');
      try { await validateExecutableDescriptor(launch.executable); } catch { throw new ProcessRuntimeError('target_changed', 'Executable identity is unavailable or changed.'); }
    } else throw new ProcessRuntimeError('invalid_argument', 'Unsupported process launch form.');
    const allowed = launch.kind === 'shell' ? this.policy.allowCommand?.(launch.command) ?? true
      : this.policy.allowArgv ? this.policy.allowArgv(Object.freeze({ cli: executablePolicyName(launch.executable), argv: Object.freeze([...launch.argv]) }))
      : this.policy.allowCommand === undefined;
    if (!allowed) throw new ProcessRuntimeError('precondition', 'Global enterprise policy rejects this command.');
    const cwd = await realpath(resolve(input.cwd));
    const identity = await stat(cwd, { bigint: true });
    if (!identity.isDirectory()) throw new ProcessRuntimeError('precondition', 'Process cwd is not a directory.');
    const pathTargets = await Promise.all((input.pathTargets ?? []).map(target => prepareProcessPath(target.requestedPath, cwd)));
    if (input.pathTargets && JSON.stringify(input.pathTargets) !== JSON.stringify(pathTargets)) throw new ProcessRuntimeError('target_changed', 'Command path identity changed during preparation.');
    const hostTargets = [...new Set(input.hostTargets ?? [])].sort();
    if (hostTargets.length > 64 || hostTargets.some(host => typeof host !== 'string' || !/^[a-zA-Z0-9.:[\]-]{1,253}$/u.test(host))) throw new ProcessRuntimeError('invalid_argument', 'Command host targets are invalid.');
    return { launch, hostPolicyRevision: this.policy.revision, cwd, cwdIdentity: { dev: String(identity.dev), ino: String(identity.ino) }, boundary: prepareSandboxBoundary(this.executor.identity, { ...this.policy, ...(input.runPolicy ?? {}) }, input.requested), runtimeLimits: this.preparationLimits(), pathTargets, hostTargets };
  }

  preparationLimits(): ProcessRuntimeLimits { return { ...this.limits }; }
  recoveryDiagnostics(): readonly string[] { return [...this.recoveryIssues]; }

  /** Host startup hook; no recovered PID is ever rebound to a controllable child. */
  async recover(): Promise<readonly { processId: string; owner: ProcessOwner; status: ProcessRuntimeStatus }[]> {
    await this.initialize();
    return [...this.records.values()].map(record => ({ processId: record.processId, owner: { ...record.owner }, status: record.status }));
  }

  async revalidate(target: PreparedProcessTarget, signal: AbortSignal): Promise<void> {
    checkSignal(signal);
    if (target.kind === 'process-control') {
      const record = await this.record(target.owner, target.processId);
      if (JSON.stringify(target.runtimeLimits) !== JSON.stringify(this.limits)) throw new ProcessRuntimeError('target_changed', 'Process Runtime limits changed.');
      if (record.runtimeId !== target.runtimeId) throw new ProcessRuntimeError('target_changed', 'The captured process generation changed.');
      if (target.action !== 'poll' && (!record.child || record.status === 'orphaned')) throw new ProcessRuntimeError('precondition', 'Orphaned processes cannot be controlled after Host restart.');
      return;
    }
    const plan = target.plan;
    const current = await this.prepareExecution({ hostId: plan.boundary.hostId, launch: plan.launch, runPolicy: { mode: plan.boundary.mode, revision: plan.boundary.policyRevision }, cwd: plan.cwd, requested: plan.boundary.requested, pathTargets: plan.pathTargets, hostTargets: plan.hostTargets });
    if (JSON.stringify(current) !== JSON.stringify(plan)) throw new ProcessRuntimeError('target_changed', 'The prepared cwd, executor, policy or sandbox boundary changed.');
    checkSignal(signal);
  }

  async prepareControl(owner: ProcessOwner, processId: string, action: 'poll' | 'write' | 'terminate'): Promise<PreparedProcessTarget> {
    const record = await this.record(owner, processId);
    if (action !== 'poll' && (!record.child || record.status === 'orphaned')) throw new ProcessRuntimeError('precondition', 'This handle is an orphan and cannot receive control commands.');
    return { kind: 'process-control', owner: { ...owner }, processId, runtimeId: record.runtimeId, runtimeLimits: this.preparationLimits(), action };
  }

  exec(input: ProcessExecInput): Promise<ProcessRuntimeSnapshot> { return this.track(this.execOwned({ ...input, prepared: structuredClone(input.prepared) })); }
  private async execOwned(input: ProcessExecInput): Promise<ProcessRuntimeSnapshot> {
    await this.initialize(); this.assertOwner(input); this.assertOpen(); checkSignal(input.signal);
    await this.revalidate({ kind: 'process-exec', plan: input.prepared }, input.signal);
    if (input.prepared.boundary.decision === 'unavailable') throw new ProcessRuntimeError('precondition', 'Required process sandbox enforcement is unavailable.');
    let timeoutMs = bounded(input.timeoutMs, Math.min(this.limits.defaultMs, this.limits.runMs), this.limits.runMs);
    if (input.deadline !== undefined) {
      const remaining = Date.parse(input.deadline) - Date.now();
      if (!Number.isFinite(remaining) || remaining <= 0) throw new ProcessRuntimeError('timeout', 'The prepared process deadline expired.');
      timeoutMs = Math.min(timeoutMs, remaining);
    }
    const key = ownerKey(input);
    const active = [...this.records.values()].filter(r => r.status === 'running' || r.status === 'orphaned' || r.status === 'unknown');
    if (active.length + this.isolatedRecords + this.reservations >= this.limits.processes || active.filter(r => ownerKey(r.owner) === key).length + (this.runReservations.get(key) ?? 0) >= this.limits.perRun || this.records.size + this.isolatedRecords + this.reservations >= 1024) throw new ProcessRuntimeError('limit', 'Concurrent process or retained-handle quota reached.');
    this.reservations++; this.runReservations.set(key, (this.runReservations.get(key) ?? 0) + 1);
    let reserved = true;
    const releaseReservation = () => { if (!reserved) return; reserved = false; this.reservations--; this.runReservations.set(key, (this.runReservations.get(key) ?? 1) - 1); };
    let record: ProcessRecord | undefined;
    try {
      const processId = requiredText(this.createProcessId(), 'processId', 128);
      if (!/^[a-zA-Z0-9_-]+$/.test(processId) || this.records.has(processId)) throw new ProcessRuntimeError('invalid_argument', 'Invalid or duplicate process handle.');
      const directory = join(this.spoolDirectory, processId);
      await mkdir(directory, { recursive: false });
      await Promise.all([this.track(writeFile(join(directory, 'stdout.log'), '', { flag: 'wx' })), this.track(writeFile(join(directory, 'stderr.log'), '', { flag: 'wx' }))]);
      let resolveDone = () => {};
      const done = new Promise<void>(resolve => { resolveDone = resolve; });
      record = { processId, owner: pickOwner(input), runtimeId: this.runtimeId, directory, stdoutPath: join(directory, 'stdout.log'), stderrPath: join(directory, 'stderr.log'), stdoutBytes: 0, stderrBytes: 0, reservedBytes: 0, stdoutWrite: Promise.resolve(), stderrWrite: Promise.resolve(), metadataWrite: Promise.resolve(), status: 'running', exitCode: null, signal: null, startedAt: this.now().toISOString(), done, resolveDone, finalized: false, revision: 0, waiters: new Set(), outputComplete: true, treeStopped: false };
      if (input.prepared.launch.kind === 'argv') record.capabilityOutput = { stdout: [], stderr: [] };
      // Publish a starting record before spawn; a crash at either boundary becomes an orphan.
      await boundedWait(this.persist(record), input.signal, 8_000);
      checkSignal(input.signal); this.assertOpen();
      await this.revalidate({ kind: 'process-exec', plan: input.prepared }, input.signal);
      if (input.deadline !== undefined) {
        timeoutMs = Math.min(timeoutMs, Date.parse(input.deadline) - Date.now());
        if (timeoutMs <= 0) throw new ProcessRuntimeError('timeout', 'The prepared process deadline expired.');
      }
      const environment = { ...this.environment };
      const launch = input.prepared.launch;
      if (launch.kind === 'argv' && launch.executable.nodePath.length && !this.policy.removeEnvironmentVariables?.some(key => key.toUpperCase() === 'NODE_PATH')) {
        const inherited = Object.entries(environment).find(([key]) => key.toUpperCase() === 'NODE_PATH')?.[1];
        for (const key of Object.keys(environment)) if (key.toUpperCase() === 'NODE_PATH') delete environment[key];
        environment.NODE_PATH = [...launch.executable.nodePath, ...(inherited ? [inherited] : [])].join(';');
      }
      const child = this.executor.spawn({ launch, cwd: input.prepared.cwd, environment, boundary: input.prepared.boundary, signal: input.signal });
      record.child = child;
      record.lifecycle = this.track(new Promise<void>(resolve => { record!.resolveLifecycle = resolve; }));
      if (child.pid !== undefined) record.pid = child.pid;
      this.records.set(processId, record);
      releaseReservation(); // Atomic handoff from startup reservation to active record.
      this.attach(record);
      if (!record.finalized) {
        record.timeout = setTimeout(() => { void this.stop(record!, 'timed_out').catch(() => undefined); }, timeoutMs);
        record.timeout.unref?.(); this.touch(record);
        record.parentSignal = input.signal;
        record.abortListener = () => { void this.stop(record!, 'terminated').catch(() => undefined); };
        input.signal.addEventListener('abort', record.abortListener, { once: true });
        if (input.signal.aborted) record.abortListener();
      }
      await boundedWait(this.persist(record), input.signal, 8_000, 'unknown').catch(error => { this.outputFailure(record!, error); });
      await Promise.race([new Promise<void>((resolve, reject) => { if (child.pid !== undefined) resolve(); else { child.once('spawn', resolve); child.once('error', reject); } }), record.done]);
      if (!input.background) await record.done;
      if (record.status === 'unknown') throw new ProcessRuntimeError('external', 'Process execution or tree termination is unconfirmed.', 'unknown');
      return await this.snapshot(record, ioBoundary(input));
    } catch (error) {
      if (record?.child) { void this.stop(record, 'terminated').catch(() => undefined); }
      if (error instanceof ProcessRuntimeError) throw error;
      throw new ProcessRuntimeError('external', 'Process startup or spool persistence failed.', record?.child ? 'unknown' : 'not_applied');
    } finally { releaseReservation(); }
  }

  poll(input: ProcessPollInput): Promise<ProcessRuntimeSnapshot> { return this.track(this.pollOwned(input)); }
  private async pollOwned(input: ProcessPollInput): Promise<ProcessRuntimeSnapshot> {
    checkSignal(input.signal);
    const record = await waitIo(this.record(input, input.processId), ioBoundary(input));
    const cursor = cursorFor(input.cursor, record);
    const waitMs = bounded(input.waitMs, 0, 30_000, true);
    if (waitMs && record.status === 'running' && record.stdoutBytes - cursor.stdoutBytes <= 3 && record.stderrBytes - cursor.stderrBytes <= 3) await this.waitForChange(record, waitMs, input.signal);
    checkSignal(input.signal);
    return this.snapshot(record, ioBoundary(input), cursor, bounded(input.maxProjectionBytes, this.limits.projectionBytes, this.limits.projectionBytes));
  }

  write(input: ProcessWriteInput): Promise<ProcessRuntimeSnapshot> { return this.track(this.writeOwned(input)); }
  private async writeOwned(input: ProcessWriteInput): Promise<ProcessRuntimeSnapshot> {
    checkSignal(input.signal);
    const boundary = ioBoundary(input, bounded(input.timeoutMs, this.limits.stdinMs, this.limits.stdinMs));
    const record = await waitIo(this.record(input, input.processId), boundary);
    const child = record.child;
    if (!child || record.status !== 'running' || !child.stdin.writable) throw new ProcessRuntimeError('precondition', 'Process stdin is not controllable.');
    if (typeof input.input !== 'string' || Buffer.byteLength(input.input) > this.limits.stdinBytes) throw new ProcessRuntimeError('limit', 'Process stdin byte quota exceeded.');
    checkIo(boundary);
    this.touch(record);
    const actual = this.track(new Promise<void>((resolve, reject) => {
      child.stdin.write(input.input, 'utf8', error => { if (error) reject(error); else resolve(); });
    }));
    try { await waitIo(actual, boundary); }
    catch (error) { void this.stop(record, 'terminated').catch(() => undefined); if (error instanceof ProcessRuntimeError) throw error; throw new ProcessRuntimeError('external', 'Process stdin write failed.', 'unknown'); }
    if (input.end) {
      checkIo(boundary);
      const ending = this.track(new Promise<void>((resolve, reject) => child.stdin.end((error?: Error | null) => error ? reject(error) : resolve())));
      try { await waitIo(ending, boundary); }
      catch { void this.stop(record, 'terminated').catch(() => undefined); throw new ProcessRuntimeError('external', 'Process stdin close is unconfirmed.', 'unknown'); }
    }
    return this.snapshot(record, ioBoundary(input), { processId: record.processId, stdoutBytes: record.stdoutBytes, stderrBytes: record.stderrBytes });
  }

  terminate(input: ProcessTerminateInput): Promise<ProcessRuntimeSnapshot> { return this.track(this.terminateOwned(input)); }
  private async terminateOwned(input: ProcessTerminateInput): Promise<ProcessRuntimeSnapshot> {
    checkSignal(input.signal);
    const boundary = ioBoundary(input, 10_000);
    const record = await waitIo(this.record(input, input.processId), boundary);
    if (!record.child || record.status === 'orphaned') throw new ProcessRuntimeError('precondition', 'Orphaned process identity cannot be safely terminated.');
    checkIo(boundary);
    await waitIo(this.stop(record, 'terminated'), boundary);
    if (!record.treeStopped) throw new ProcessRuntimeError('external', 'Process tree termination is unconfirmed.', 'unknown');
    return this.snapshot(record, ioBoundary(input));
  }

  /** Bounded raw complete-spool payload; Tool Runtime owns any resulting contentRef/artifact. */
  readCompleteSpool(input: ProcessOwner & ProcessIoContext & { processId: string }): Promise<ProcessCompleteSpool> { return this.track(this.readCompleteSpoolOwned(input)); }
  private async readCompleteSpoolOwned(input: ProcessOwner & ProcessIoContext & { processId: string }): Promise<ProcessCompleteSpool> {
    checkSignal(input.signal);
    const boundary = ioBoundary(input);
    const record = await waitIo(this.record(input, input.processId), boundary);
    if (record.status === 'unknown') throw new ProcessRuntimeError('external', 'Process output integrity is unconfirmed.', 'unknown');
    await this.waitOutput(record, boundary);
    const [stdout, stderr] = await this.readSpool(record, 0, 0, this.limits.processBytes, false, boundary);
    checkSignal(input.signal);
    return { stdout, stderr, outputComplete: record.outputComplete, outputReadable: record.outputReadable !== false };
  }

  close(): Promise<void> {
    this.closing = true;
    this.closeDrain ??= (async () => {
      await this.initialize();
      while (true) {
        await Promise.allSettled([...this.records.values()].filter(r => r.child && !r.treeStopped && !this.nativeNaturalExit(r)).map(r => this.stop(r, 'terminated')));
        const pending = [...this.operations];
        if (pending.length === 0) break;
        await Promise.allSettled(pending);
      }
      if (this.isolatedRecords > 0 || [...this.records.values()].some(r => !r.treeStopped && !this.nativeNaturalExit(r) || r.metadataFailed)) throw new ProcessRuntimeError('external', 'Some process trees or terminal metadata remain unconfirmed after Host close.', 'unknown');
      // Keep bounded spools and metadata for recovery/result export; never erase user output on close.
    })();
    // The bounded caller does not own the actual shutdown. Keep closeDrain and
    // every real I/O/termination promise alive; a timeout cannot close helpers.
    return this.closeOperation ??= boundedWait(this.closeDrain, new AbortController().signal, 30_000, 'unknown');
  }

  /** Host retains this actual shutdown owner after a bounded close rejects. */
  drain(): Promise<void> {
    return this.closeDrain ?? Promise.reject(new ProcessRuntimeError('precondition', 'Start process Runtime close before awaiting its drain.'));
  }

  private attach(record: ProcessRecord): void {
    const child = record.child!;
    for (const stream of ['stdout', 'stderr'] as const) {
      child[stream].on('data', (chunk: Buffer | string) => {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (!record.outputComplete) return;
        const key = ownerKey(record.owner);
        if (record.reservedBytes + data.length > this.limits.processBytes || (this.runBytes.get(key) ?? 0) + data.length > this.limits.runBytes) { this.outputFailure(record, new Error('Process spool quota exceeded.')); return; }
        record.reservedBytes += data.length; this.runBytes.set(key, (this.runBytes.get(key) ?? 0) + data.length);
        if (record.capabilityOutput) {
          // Retain at most the ordinary spool quota in memory until end-of-stream,
          // so split credentials and binary output cannot reach durable spools.
          record.capabilityOutput[stream].push(data); this.touch(record); return;
        }
        child[stream].pause(); this.touch(record);
        const pending = this.track(record[stream === 'stdout' ? 'stdoutWrite' : 'stderrWrite'].then(async () => {
          await appendFile(stream === 'stdout' ? record.stdoutPath : record.stderrPath, data, { flag: constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0) });
          if (stream === 'stdout') record.stdoutBytes += data.length; else record.stderrBytes += data.length;
          this.notify(record);
        }).catch(error => { this.outputFailure(record, error); }).finally(() => { child[stream].resume(); }));
        if (stream === 'stdout') record.stdoutWrite = pending; else record.stderrWrite = pending;
      });
      child[stream].on('error', error => this.outputFailure(record, error));
    }
    child.stdin.on('error', () => undefined);
    child.once('error', () => { record.error = 'Process execution failed.'; record.exitStatus = 'failed'; });
    child.once('close', (code, signal) => {
      record.rootClosed = true;
      if (record.capabilityOutput) {
        try { this.flushCapabilityOutput(record); }
        catch { this.outputFailure(record, new Error('Command output could not be safely retained.')); }
      }
      void this.track(this.finalize(record, code, signal, record.exitStatus ?? record.stopReason ?? 'exited')).finally(() => {
        // Finalize may have returned an unknown waiter result. Its actual late
        // output/metadata drains still gate the spawn-owned lifecycle.
        void Promise.allSettled([record.stdoutWrite, record.stderrWrite, record.metadataWrite]).then(() => record.resolveLifecycle?.());
      }).catch(() => undefined);
    });
  }

  private flushCapabilityOutput(record: ProcessRecord): void {
    const buffers = record.capabilityOutput!;
    const key = ownerKey(record.owner);
    const maximumTotal = Math.min(this.limits.processBytes, this.limits.runBytes - ((this.runBytes.get(key) ?? 0) - record.reservedBytes));
    for (const stream of ['stdout', 'stderr'] as const) {
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(buffers[stream])); }
      catch { text = '[Binary command output omitted.]'; record.outputComplete = false; }
      const bytes = Buffer.from(this.commandRedactor.redact(text).text);
      buffers[stream] = [];
      const maximum = maximumTotal - record.stdoutBytes - record.stderrBytes;
      const data = bytes.subarray(0, Math.max(0, maximum));
      if (data.length !== bytes.length) record.outputComplete = false;
      if (stream === 'stdout') record.stdoutBytes = data.length; else record.stderrBytes = data.length;
      record[stream === 'stdout' ? 'stdoutWrite' : 'stderrWrite'] = this.track(appendFile(stream === 'stdout' ? record.stdoutPath : record.stderrPath, data, { flag: constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0) }).catch(error => this.outputFailure(record, error)));
    }
    const additional = Math.max(0, record.stdoutBytes + record.stderrBytes - record.reservedBytes);
    record.reservedBytes += additional;
    this.runBytes.set(key, (this.runBytes.get(key) ?? 0) + additional);
  }

  private outputFailure(record: ProcessRecord, error: unknown): void {
    void error;
    record.outputComplete = false; record.error = 'Process output persistence failed.';
    if (this.processOutcomeKnown(record)) { this.notify(record); return; }
    this.markUnknown(record, 'Process output integrity cannot be confirmed.');
    void this.stop(record, 'terminated').catch(() => undefined); this.notify(record);
  }

  private processOutcomeKnown(record: ProcessRecord): boolean {
    return (record.treeStopped || this.nativeNaturalExit(record)) && (record.rootClosed === true || record.finalized) && record.status !== 'running' && record.status !== 'orphaned' && (record.exitCode !== null || record.signal !== null);
  }

  private nativeNaturalExit(record: ProcessRecord): boolean {
    return this.executor.naturalExitTreeProof === 'unverified' && record.rootClosed === true && !record.stopReason && !record.terminationFailure && record.exitCode !== null && record.signal === null;
  }

  private markUnknown(record: ProcessRecord, summary: string): void {
    record.terminationFailure = true; record.status = 'unknown'; record.error = summary;
    record.resolveDone(); this.notify(record);
  }

  private track<T>(actual: Promise<T>): Promise<T> {
    this.operations.add(actual);
    void actual.then(() => this.operations.delete(actual), () => this.operations.delete(actual));
    return actual;
  }

  private async stop(record: ProcessRecord, reason: 'timed_out' | 'terminated'): Promise<void> {
    if (record.treeStopped) return;
    if (!record.child) throw new ProcessRuntimeError('precondition', 'Process identity is no longer controllable.');
    record.stopReason ??= reason;
    if (!record.stopPromise) {
      this.beginTreeProof(record, false);
    }
    await record.stopPromise!;
    await Promise.race([record.done, delay(PROCESS_CLOSE_GRACE_MS)]);
    if (!record.finalized) {
      this.markUnknown(record, 'Process close was not confirmed after tree termination.');
      void this.persist(record).catch(() => undefined);
      throw new ProcessRuntimeError('external', 'Process close was not confirmed after tree termination.', 'unknown');
    }
  }

  private beginTreeProof(record: ProcessRecord, naturalExit: boolean): void {
    if (naturalExit ? record.confirmationPromise : record.stopPromise) return;
    const controller = new AbortController();
    const deadline = new Date(this.now().getTime() + 8_000).toISOString();
    const timer = setTimeout(() => controller.abort(), 8_000);
    const actual = this.track(Promise.resolve().then(async () => {
      if (naturalExit) {
        if (!this.executor.confirmExit) throw new Error('Executor has no natural-exit tree proof.');
        await this.executor.confirmExit(record.child!, { signal: controller.signal, deadline });
      } else {
        // A failed confirm-only operation cannot permanently occupy terminate.
        // Serialize with its actual drain, then run one shared termination.
        await record.confirmationDrain?.catch(() => undefined);
        if (!record.treeStopped) await this.executor.terminate(record.child!, { signal: controller.signal, deadline });
      }
      record.treeStopped = true;
      if (!naturalExit && record.rootClosed && record.exitStatus && !record.metadataFailed) {
        record.terminationFailure = false; record.status = record.exitStatus;
        void this.persist(record).catch(() => undefined);
      }
    }).finally(() => clearTimeout(timer)));
    const waiting = boundedWait(actual, controller.signal, 8_000, 'unknown').catch(() => {
      this.markUnknown(record, 'Process tree termination is unconfirmed.');
      void this.persist(record).catch(() => undefined);
      throw new ProcessRuntimeError('external', 'Process tree termination is unconfirmed.', 'unknown');
    });
    if (naturalExit) { record.confirmationDrain = actual; record.confirmationPromise = waiting; }
    else { record.terminationDrain = actual; record.stopPromise = waiting; }
    void waiting.catch(() => undefined);
  }

  private async finalize(record: ProcessRecord, code: number | null, signal: NodeJS.Signals | null, status: ProcessRuntimeStatus): Promise<void> {
    if (record.finalized) return;
    record.finalized = true;
    record.exitCode = code; record.signal = signal; record.exitStatus = status;
    if (record.timeout) clearTimeout(record.timeout); if (record.idle) clearTimeout(record.idle);
    if (record.parentSignal && record.abortListener) record.parentSignal.removeEventListener('abort', record.abortListener);
    if (!record.stopPromise && !this.nativeNaturalExit(record)) this.beginTreeProof(record, true);
    await (record.stopPromise ?? record.confirmationPromise)?.catch(() => undefined);
    try { await boundedWait(Promise.all([record.stdoutWrite, record.stderrWrite]), new AbortController().signal, 8_000, 'unknown'); }
    catch { this.markUnknown(record, 'Process output drain did not complete within its deadline.'); }
    record.status = record.terminationFailure ? 'unknown' : status;
    record.exitCode = code; record.signal = signal; record.finishedAt = this.now().toISOString();
    record.expiresAt = new Date(this.now().getTime() + this.limits.retentionMs).toISOString();
    try { await boundedWait(this.persist(record), new AbortController().signal, 8_000, 'unknown'); } catch { record.metadataFailed = true; record.outputComplete = false; this.markUnknown(record, 'Process terminal metadata could not be persisted.'); }
    record.resolveDone(); this.notify(record);
  }

  private async snapshot(record: ProcessRecord, boundary: IoBoundary, cursor = { processId: record.processId, stdoutBytes: 0, stderrBytes: 0 }, maximum = this.limits.projectionBytes): Promise<ProcessRuntimeSnapshot> {
    if (record.status === 'unknown') throw new ProcessRuntimeError('external', 'Process execution or output integrity is unconfirmed.', 'unknown');
    await this.waitOutput(record, boundary);
    const [stdout, stderr] = await this.readSpool(record, cursor.stdoutBytes, cursor.stderrBytes, Math.max(4, Math.floor(maximum / 2)), record.status === 'running', boundary);
    return { processId: record.processId, ...(record.pid === undefined ? {} : { pid: record.pid }), status: record.status, exitCode: record.exitCode, signal: record.signal, timedOut: record.status === 'timed_out', startedAt: record.startedAt, ...(record.finishedAt === undefined ? {} : { finishedAt: record.finishedAt }), ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }), output: { stdout, stderr }, nextCursor: { processId: record.processId, stdoutBytes: stdout.toByte, stderrBytes: stderr.toByte }, outputComplete: record.outputComplete, outputReadable: record.outputReadable !== false, treeStopped: record.treeStopped, treeStopProof: record.treeStopped ? 'verified' : 'unverified', ...(record.error === undefined ? {} : { error: record.error }) };
  }

  private async waitOutput(record: ProcessRecord, boundary: IoBoundary): Promise<void> {
    try { await waitIo(Promise.all([record.stdoutWrite, record.stderrWrite]), boundary); }
    catch (error) {
      this.outputFailure(record, error);
      throw error instanceof ProcessRuntimeError ? error : new ProcessRuntimeError('external', 'Process output drain failed.', this.processOutcomeKnown(record) ? 'not_applied' : 'unknown');
    }
  }

  private async readSpool(record: ProcessRecord, stdout: number, stderr: number, maximum: number, live: boolean, boundary: IoBoundary): Promise<[ProcessOutputProjection, ProcessOutputProjection]> {
    const readOne = async (path: string, from: number, total: number): Promise<ProcessOutputProjection> => {
      try {
        checkIo(boundary);
        // The invocation only owns the bounded wait. The Runtime owns open,
        // read and finally-close through actual settlement, including late open.
        return await waitIo(this.track(readProjection(path, from, total, maximum, live, boundary)), boundary);
      } catch (error) {
        if (error instanceof ProcessRuntimeError && error.kind === 'invalid_cursor') throw error;
        record.outputReadable = false;
        this.outputFailure(record, error);
        void this.persist(record).catch(() => undefined);
        if (error instanceof ProcessRuntimeError && (error.kind === 'cancelled' || error.kind === 'timeout')) throw error;
        if (this.processOutcomeKnown(record)) return { text: '', encoding: 'utf-8', fromByte: from, toByte: from, totalBytes: total, truncated: from < total };
        throw new ProcessRuntimeError('external', 'Process output could not be read reliably.', 'unknown');
      }
    };
    return Promise.all([readOne(record.stdoutPath, stdout, record.stdoutBytes), readOne(record.stderrPath, stderr, record.stderrBytes)]);
  }

  private initialize(): Promise<void> { return this.initialized ??= this.track(this.loadSpools().catch(error => { if (error instanceof ProcessRuntimeError) throw error; throw new ProcessRuntimeError('external', 'Process spool recovery could not be completed.'); })); }
  private async loadSpools(): Promise<void> {
    await mkdir(this.spoolDirectory, { recursive: true });
    const directory = await opendir(this.spoolDirectory);
    let count = 0;
    for await (const entry of directory) {
      if (++count > 1024) throw new ProcessRuntimeError('limit', 'Process spool directory exceeds recovery entry quota.');
      if (!entry.isDirectory() || !/^[a-zA-Z0-9_-]{1,128}$/.test(entry.name)) continue;
      const root = join(this.spoolDirectory, entry.name);
      const path = join(root, 'process.json');
      let meta: StoredProcessMetadata;
      try {
        for (const file of [path, join(root, 'stdout.log'), join(root, 'stderr.log')]) if (!(await lstat(file)).isFile()) throw new Error('Spool entries must be regular files.');
        const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const buffer = Buffer.alloc(16_385);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          if (bytesRead > 16_384) throw new Error('Metadata is oversized.');
          const parsed: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
          validateMetadata(parsed, entry.name); meta = parsed;
        } finally { await handle.close(); }
        this.assertOwner(meta.owner);
      } catch {
        this.isolatedRecords++;
        this.recoveryIssues.push('A process spool entry is incomplete or incompatible and was isolated.');
        continue;
      }
      let stdoutBytes: number, stderrBytes: number;
      try { stdoutBytes = (await stat(join(root, 'stdout.log'))).size; stderrBytes = (await stat(join(root, 'stderr.log'))).size; }
      catch { this.isolatedRecords++; this.recoveryIssues.push('A process spool could not be read and was isolated.'); continue; }
      if (stdoutBytes + stderrBytes > this.limits.processBytes) { this.isolatedRecords++; this.recoveryIssues.push('A recovered process spool exceeds quota and was isolated.'); continue; }
      const active = meta.status === 'running' || meta.status === 'unknown';
      const record: ProcessRecord = {
        processId: entry.name,
        owner: pickOwner(meta.owner),
        runtimeId: meta.runtimeId,
        ...(typeof meta.pid === 'number' ? { pid: meta.pid } : {}),
        directory: root,
        stdoutPath: join(root, 'stdout.log'),
        stderrPath: join(root, 'stderr.log'),
        stdoutBytes,
        stderrBytes,
        reservedBytes: stdoutBytes + stderrBytes,
        stdoutWrite: Promise.resolve(),
        stderrWrite: Promise.resolve(),
        metadataWrite: Promise.resolve(),
        status: active ? 'orphaned' : meta.status,
        exitCode: typeof meta.exitCode === 'number' ? meta.exitCode : null,
        signal: meta.signal ?? null,
        startedAt: meta.startedAt,
        ...(meta.finishedAt ? { finishedAt: meta.finishedAt } : {}),
        ...(meta.expiresAt ? { expiresAt: meta.expiresAt } : {}),
        outputComplete: !active && meta.outputComplete === true,
        treeStopped: !active && meta.treeStopped === true,
        ...(active
          ? { error: 'Host restarted; live process ownership cannot be re-established.' }
          : meta.error
            ? { error: meta.error }
            : {}),
        done: Promise.resolve(),
        resolveDone: () => {},
        finalized: true,
        revision: 0,
        waiters: new Set(),
      };
      const key = ownerKey(record.owner); this.runBytes.set(key, (this.runBytes.get(key) ?? 0) + record.reservedBytes);
      if ((this.runBytes.get(key) ?? 0) > this.limits.runBytes) this.recoveryIssues.push('A recovered Run exceeds its spool quota; further output is blocked.');
      if (record.error) record.error = active ? 'Host restarted; live process ownership cannot be re-established.' : 'Recovered process has incomplete or unconfirmed output.';
      this.records.set(record.processId, record); if (active) await this.persist(record).catch(() => { this.markUnknown(record, 'Recovered process metadata could not be persisted.'); });
    }
  }

  private async persist(record: ProcessRecord): Promise<void> {
    const metadata = JSON.stringify({ version: 1, processId: record.processId, owner: record.owner, runtimeId: record.runtimeId, pid: record.pid ?? null, status: record.status, exitCode: record.exitCode, signal: record.signal, startedAt: record.startedAt, finishedAt: record.finishedAt ?? null, expiresAt: record.expiresAt ?? null, outputComplete: record.outputComplete, treeStopped: record.treeStopped, error: record.error ?? null });
    record.metadataWrite = this.track(record.metadataWrite.catch(() => undefined).then(async () => {
      const temporary = join(record.directory, 'process.' + randomUUID() + '.tmp');
      await writeFile(temporary, metadata, { flag: 'wx' }); await rename(temporary, join(record.directory, 'process.json'));
    }).catch(() => {
      record.metadataFailed = true; record.outputComplete = false; this.markUnknown(record, 'Process metadata could not be persisted.');
      if (record.child && !record.stopPromise) void this.stop(record, 'terminated').catch(() => undefined);
      throw new ProcessRuntimeError('external', 'Process metadata could not be persisted.', record.child ? 'unknown' : 'not_applied');
    }));
    return record.metadataWrite;
  }

  private async record(owner: ProcessOwner, processId: string): Promise<ProcessRecord> {
    this.assertOpen(); this.assertOwner(owner); await this.initialize();
    const record = this.records.get(requiredText(processId, 'processId', 128));
    if (!record || ownerKey(record.owner) !== ownerKey(owner)) throw new ProcessRuntimeError('not_found', 'Process handle is outside the current Host/Session/Run.');
    if (record.expiresAt && this.now().getTime() >= Date.parse(record.expiresAt) && record.status !== 'orphaned' && record.status !== 'unknown') throw new ProcessRuntimeError('precondition', 'Process handle expired; retained output requires explicit Host retention handling.');
    return record;
  }
  private touch(record: ProcessRecord): void { if (record.finalized) return; if (record.idle) clearTimeout(record.idle); record.idle = setTimeout(() => { void this.stop(record, 'timed_out').catch(() => undefined); }, this.limits.idleMs); record.idle.unref?.(); }
  private notify(record: ProcessRecord): void { record.revision++; for (const wake of [...record.waiters]) wake(); }
  private async waitForChange(record: ProcessRecord, waitMs: number, signal: AbortSignal): Promise<void> {
    let wake = () => {};
    const changed = new Promise<void>(resolve => { wake = resolve; record.waiters.add(wake); });
    try { await boundedWait(Promise.race([changed, delay(waitMs)]), signal, waitMs + 1); }
    finally { record.waiters.delete(wake); }
  }
  private assertOwner(owner: ProcessOwner): void { for (const field of [owner.hostId, owner.sessionId, owner.runId]) requiredText(field, 'process owner', 512); if (owner.hostId !== this.executor.identity.hostId) throw new ProcessRuntimeError('not_found', 'Process belongs to another Host.'); }
  private assertOpen(): void { if (this.closing) throw new ProcessRuntimeError('precondition', 'Process Runtime is closing.'); }
}

function pickOwner(owner: ProcessOwner): ProcessOwner { return { hostId: owner.hostId, sessionId: owner.sessionId, runId: owner.runId }; }
function ownerKey(owner: ProcessOwner): string { return JSON.stringify([owner.hostId, owner.sessionId, owner.runId]); }
export async function prepareProcessPath(path: string, cwd: string): Promise<ProcessPathTarget> {
  const requestedPath = resolve(cwd, path);
  let candidate = requestedPath;
  const missing: string[] = [];
  while (true) {
    try {
      const identityPath = await realpath(candidate);
      const identity = await stat(identityPath, { bigint: true });
      return { requestedPath, canonicalPath: join(identityPath, ...missing), identityPath, identity: { dev: String(identity.dev), ino: String(identity.ino) } };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(candidate) === candidate) throw new ProcessRuntimeError('precondition', 'Command path identity could not be prepared.');
      missing.unshift(basename(candidate)); candidate = dirname(candidate);
    }
  }
}
function requiredText(value: string, label: string, max = 8192): string { if (typeof value !== 'string' || !value.trim() || value.length > max) throw new ProcessRuntimeError('invalid_argument', label + ' is invalid.'); return value; }
function bounded(value: number | undefined, fallback: number, max: number, zero = false): number { if (value === undefined) return fallback; if (!Number.isSafeInteger(value) || value < (zero ? 0 : 1) || value > max) throw new ProcessRuntimeError('invalid_argument', 'Process numeric bound is invalid.'); return value; }
function checkSignal(signal: AbortSignal): void { if (signal.aborted) throw new ProcessRuntimeError('cancelled', 'Process operation was cancelled.'); }
function ioBoundary(context: ProcessIoContext, maximumMs = 8_000): IoBoundary {
  const deadline = context.deadline === undefined ? Date.now() + maximumMs : Date.parse(context.deadline);
  if (!Number.isFinite(deadline)) throw new ProcessRuntimeError('invalid_argument', 'Process I/O deadline is invalid.');
  return { signal: context.signal, deadline: Math.min(deadline, Date.now() + maximumMs) };
}
function checkIo(boundary: IoBoundary): void {
  checkSignal(boundary.signal);
  if (Date.now() >= boundary.deadline) throw new ProcessRuntimeError('timeout', 'Process I/O deadline expired.');
}
async function waitIo<T>(actual: Promise<T>, boundary: IoBoundary): Promise<T> {
  // Always attach a rejection consumer, even when an already-expired boundary
  // rejects before the non-cancellable operation returns.
  return boundedWait(actual, boundary.signal, Math.max(0, boundary.deadline - Date.now()), 'unknown');
}
async function boundedWait<T>(actual: Promise<T>, signal: AbortSignal, timeoutMs: number, outcome: 'not_applied' | 'unknown' = 'not_applied'): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const stop = () => { cleanup(); reject(new ProcessRuntimeError('cancelled', 'Process operation was cancelled.', outcome)); };
    const timer = setTimeout(() => { cleanup(); reject(new ProcessRuntimeError('timeout', 'Process operation timed out.', outcome)); }, timeoutMs);
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', stop); };
    actual.then(value => { cleanup(); resolve(value); }, error => {
      cleanup();
      reject(error instanceof Error ? error : new Error('Process operation failed.'));
    });
    signal.addEventListener('abort', stop, { once: true }); if (signal.aborted) stop();
  });
}
function cursorFor(cursor: ProcessOutputCursor | undefined, record: ProcessRecord): ProcessOutputCursor {
  const value = cursor ?? { processId: record.processId, stdoutBytes: 0, stderrBytes: 0 };
  if (value.processId !== record.processId || !Number.isSafeInteger(value.stdoutBytes) || !Number.isSafeInteger(value.stderrBytes) || value.stdoutBytes < 0 || value.stderrBytes < 0 || value.stdoutBytes > record.stdoutBytes || value.stderrBytes > record.stderrBytes) throw new ProcessRuntimeError('invalid_cursor', 'Process cursor is invalid or belongs to another handle.');
  return { ...value };
}
async function readProjection(path: string, fromByte: number, totalBytes: number, maxBytes: number, live: boolean, boundary: IoBoundary): Promise<ProcessOutputProjection> {
  checkIo(boundary);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    checkIo(boundary); // A late open only enters finally-close, never starts read.
    const count = Math.min(maxBytes, totalBytes - fromByte);
    const buffer = Buffer.alloc(count);
    const { bytesRead } = await handle.read(buffer, 0, count, fromByte);
    checkIo(boundary);
    if (bytesRead !== count) throw new ProcessRuntimeError('external', 'Process spool length changed unexpectedly.', 'unknown');
    let bytes = buffer.subarray(0, bytesRead);
    if (fromByte > 0 && bytes.length && (bytes[0]! & 0xc0) === 0x80) throw new ProcessRuntimeError('invalid_cursor', 'Cursor splits a UTF-8 character.');
    let text: string | undefined;
    // A completed stream's malformed tail is binary data, not a prefix to
    // withhold forever. Only withhold a possible unfinished code point while
    // the stream can grow or this projection ends before the stored tail.
    const maxTrim = live || fromByte + bytesRead < totalBytes ? Math.min(3, bytes.length) : 0;
    for (let trim = 0; trim <= maxTrim; trim++) {
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytes.length - trim)); bytes = bytes.subarray(0, bytes.length - trim); break; } catch { /* Preserve a complete UTF-8 prefix or use lossless binary output. */ }
    }
    const encoding = text === undefined ? 'base64' : 'utf-8';
    return { text: text ?? bytes.toString('base64'), encoding, fromByte, toByte: fromByte + bytes.length, totalBytes, truncated: fromByte + bytes.length < totalBytes };
  } finally { await handle.close(); }
}
async function delay(ms: number): Promise<void> { await new Promise<void>(resolve => setTimeout(resolve, ms)); }

function validateMetadata(value: unknown, processId: string): asserts value is StoredProcessMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid process metadata.');
  const meta = value as Record<string, unknown>;
  if (meta.version !== 1 || meta.processId !== processId || !['running', 'exited', 'failed', 'timed_out', 'terminated', 'orphaned', 'unknown'].includes(String(meta.status)) || !meta.owner || typeof meta.owner !== 'object' || Array.isArray(meta.owner)) throw new Error('Unsupported process metadata.');
  const owner = meta.owner as Record<string, unknown>;
  for (const key of ['hostId', 'sessionId', 'runId']) requiredText(owner[key] as string, 'stored owner', 512);
  requiredText(meta.runtimeId as string, 'stored generation', 128);
  for (const key of ['startedAt', 'finishedAt', 'expiresAt']) if (!(key !== 'startedAt' && meta[key] === null) && (typeof meta[key] !== 'string' || !Number.isFinite(Date.parse(meta[key])))) throw new Error('Invalid process timestamp.');
  if (typeof meta.outputComplete !== 'boolean' || typeof meta.treeStopped !== 'boolean' || meta.pid !== null && (!Number.isSafeInteger(meta.pid) || (meta.pid as number) <= 0) || meta.exitCode !== null && !Number.isSafeInteger(meta.exitCode) || meta.signal !== null && (typeof meta.signal !== 'string' || !/^SIG[A-Z0-9]+$/.test(meta.signal)) || meta.error !== null && (typeof meta.error !== 'string' || meta.error.length > 4096)) throw new Error('Invalid process state metadata.');
}

async function terminateProcessTree(
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) {
    child.kill();
    return;
  }
  if (process.platform === 'win32') {
    // child.kill uses the original ChildProcess OS handle. Never reopen a PID
    // after spawn: a numeric PID may now identify an unrelated process.
    child.kill();
    throw new Error('Native Windows root stop does not prove descendant containment.');
  }

  signalProcessGroup(pid, 'SIGTERM', child);
  await delay(PROCESS_TREE_KILL_GRACE_MS);
  // Root exit does not imply its still-running process group exited.
  signalProcessGroup(pid, 'SIGKILL', child);
  const deadline = Date.now() + PROCESS_CLOSE_GRACE_MS;
  while (Date.now() < deadline) {
    try { process.kill(-pid, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    await delay(25);
  }
  throw new Error('Could not confirm that the process group stopped.');
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals, child: ChildProcessWithoutNullStreams): void {
  try { process.kill(-pid, signal); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return; child.kill(signal); throw new ProcessRuntimeError('external', 'Process group signal could not be confirmed.', 'unknown'); }
}
