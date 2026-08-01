import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { appendFile, mkdir, open, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_PROJECTION_BYTES = 32 * 1024;
const DEFAULT_RETENTION_MS = 15 * 60_000;
const PROCESS_TREE_KILL_GRACE_MS = 250;
const PROCESS_CLOSE_GRACE_MS = 2_000;

export type ProcessRuntimeStatus =
  | 'running'
  | 'exited'
  | 'failed'
  | 'timed-out'
  | 'terminated';

export type ProcessOutputCursor = {
  stdoutBytes: number;
  stderrBytes: number;
};

export type ProcessOutputProjection = {
  text: string;
  fromByte: number;
  toByte: number;
  totalBytes: number;
  truncated: boolean;
  omittedBytes?: number;
};

export type ProcessRuntimeSnapshot = {
  processId: string;
  pid?: number;
  status: ProcessRuntimeStatus;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  startedAt: string;
  finishedAt?: string;
  expiresAt?: string;
  output: {
    stdout: ProcessOutputProjection;
    stderr: ProcessOutputProjection;
  };
  nextCursor: ProcessOutputCursor;
  error?: string;
};

export type ProcessRuntimeOptions = {
  spoolDirectory: string;
  defaultTimeoutMs?: number;
  maxProjectionBytes?: number;
  retentionMs?: number;
  environment?: NodeJS.ProcessEnv;
  now?: () => Date;
  createProcessId?: () => string;
};

export type ProcessExecInput = {
  sessionId: string;
  command: string;
  cwd: string;
  background?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type ProcessPollInput = {
  sessionId: string;
  processId: string;
  cursor?: ProcessOutputCursor;
  maxProjectionBytes?: number;
  waitMs?: number;
};

export type ProcessWriteInput = {
  sessionId: string;
  processId: string;
  input: string;
  end?: boolean;
};

export type ProcessTerminateInput = {
  sessionId: string;
  processId: string;
};

type StopReason = 'timed-out' | 'terminated';

type ProcessRecord = {
  processId: string;
  sessionId: string;
  command: string;
  cwd: string;
  child: ChildProcessWithoutNullStreams;
  directory: string;
  stdoutPath: string;
  stderrPath: string;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutWrite: Promise<void>;
  stderrWrite: Promise<void>;
  status: ProcessRuntimeStatus;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  startedAt: Date;
  finishedAt?: Date;
  expiresAt?: Date;
  error?: string;
  stopReason?: StopReason;
  stopPromise?: Promise<void>;
  timeout?: ReturnType<typeof setTimeout>;
  parentSignal?: AbortSignal;
  abortListener?: () => void;
  done: Promise<void>;
  resolveDone: () => void;
  finalized: boolean;
  revision: number;
  waiters: Set<() => void>;
};

/**
 * Session-isolated process handles with disk-backed output spools.
 *
 * Handles are intentionally process-local and become invalid after a Runtime
 * restart. Output is bounded only when projected to a model; the spool remains
 * available until the configured retention period expires.
 */
export class ProcessRuntime {
  private readonly records = new Map<string, ProcessRecord>();
  private readonly spoolDirectory: string;
  private readonly defaultTimeoutMs: number;
  private readonly maxProjectionBytes: number;
  private readonly retentionMs: number;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly now: () => Date;
  private readonly createProcessId: () => string;
  private closed = false;

  constructor(options: ProcessRuntimeOptions) {
    if (!options.spoolDirectory.trim()) throw new Error('Process spoolDirectory is required.');
    this.spoolDirectory = resolve(options.spoolDirectory);
    this.defaultTimeoutMs = positiveInteger(options.defaultTimeoutMs, DEFAULT_TIMEOUT_MS);
    this.maxProjectionBytes = positiveInteger(
      options.maxProjectionBytes,
      DEFAULT_PROJECTION_BYTES,
    );
    this.retentionMs = positiveInteger(options.retentionMs, DEFAULT_RETENTION_MS);
    this.environment = options.environment ?? safeProcessEnvironment();
    this.now = options.now ?? (() => new Date());
    this.createProcessId = options.createProcessId ?? randomUUID;
  }

  async exec(input: ProcessExecInput): Promise<ProcessRuntimeSnapshot> {
    this.assertOpen();
    await this.sweepExpired();
    const sessionId = requiredText(input.sessionId, 'sessionId');
    const command = requiredText(input.command, 'command');
    const cwd = resolve(requiredText(input.cwd, 'cwd'));
    if (input.signal?.aborted) throw abortError('Process was cancelled before it started.');

    const processId = requiredText(this.createProcessId(), 'generated processId');
    if (this.records.has(processId)) throw new Error(`Duplicate process handle: ${processId}.`);
    const directory = join(this.spoolDirectory, processId);
    const stdoutPath = join(directory, 'stdout.log');
    const stderrPath = join(directory, 'stderr.log');
    await mkdir(directory, { recursive: true });
    await Promise.all([writeFile(stdoutPath, ''), writeFile(stderrPath, '')]);

    const child = spawn(command, {
      cwd,
      env: this.environment,
      shell: true,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let resolveDone: () => void = () => {};
    const done = new Promise<void>((resolvePromise) => {
      resolveDone = resolvePromise;
    });
    const record: ProcessRecord = {
      processId,
      sessionId,
      command,
      cwd,
      child,
      directory,
      stdoutPath,
      stderrPath,
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutWrite: Promise.resolve(),
      stderrWrite: Promise.resolve(),
      status: 'running',
      exitCode: null,
      signal: null,
      startedAt: this.now(),
      done,
      resolveDone,
      finalized: false,
      revision: 0,
      waiters: new Set(),
    };
    this.records.set(processId, record);
    this.attachOutput(record);
    this.attachLifecycle(record);

    const timeoutMs = positiveInteger(input.timeoutMs, this.defaultTimeoutMs);
    record.timeout = setTimeout(() => {
      void this.stopRecord(record, 'timed-out');
    }, timeoutMs);
    record.timeout.unref?.();
    if (input.signal) {
      const abortListener = () => {
        void this.stopRecord(record, 'terminated');
      };
      record.parentSignal = input.signal;
      record.abortListener = abortListener;
      input.signal.addEventListener('abort', abortListener, { once: true });
    }

    await this.waitForSpawn(record);
    if (input.signal?.aborted) void this.stopRecord(record, 'terminated');
    if (input.background !== true) await record.done;
    return this.snapshot(record, { stdoutBytes: 0, stderrBytes: 0 });
  }

  async poll(input: ProcessPollInput): Promise<ProcessRuntimeSnapshot> {
    this.assertOpen();
    await this.sweepExpired();
    const record = this.ownedRecord(input.sessionId, input.processId);
    const cursor = normalizeCursor(input.cursor, record);
    const waitMs = nonNegativeInteger(input.waitMs, 0);
    if (
      waitMs > 0 &&
      record.status === 'running' &&
      cursor.stdoutBytes === record.stdoutBytes &&
      cursor.stderrBytes === record.stderrBytes
    ) {
      await this.waitForChange(record, waitMs);
    }
    return this.snapshot(
      record,
      cursor,
      positiveInteger(input.maxProjectionBytes, this.maxProjectionBytes),
    );
  }

  async write(input: ProcessWriteInput): Promise<ProcessRuntimeSnapshot> {
    this.assertOpen();
    await this.sweepExpired();
    const record = this.ownedRecord(input.sessionId, input.processId);
    if (record.status !== 'running' || !record.child.stdin.writable) {
      throw new Error('Process stdin is no longer writable.');
    }
    await new Promise<void>((resolvePromise, reject) => {
      record.child.stdin.write(input.input, 'utf8', (error) => {
        if (error) reject(error);
        else resolvePromise();
      });
    });
    if (input.end === true) record.child.stdin.end();
    return this.snapshot(record, {
      stdoutBytes: record.stdoutBytes,
      stderrBytes: record.stderrBytes,
    });
  }

  async terminate(input: ProcessTerminateInput): Promise<ProcessRuntimeSnapshot> {
    this.assertOpen();
    await this.sweepExpired();
    const record = this.ownedRecord(input.sessionId, input.processId);
    if (record.status === 'running') await this.stopRecord(record, 'terminated');
    await record.done;
    return this.snapshot(record, { stdoutBytes: 0, stderrBytes: 0 });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const records = [...this.records.values()];
    await Promise.allSettled(
      records.map(async (record) => {
        if (record.status === 'running') await this.stopRecord(record, 'terminated');
        await record.done;
        await rm(record.directory, { recursive: true, force: true });
      }),
    );
    this.records.clear();
  }

  private attachOutput(record: ProcessRecord): void {
    record.child.stdout.on('data', (chunk: Buffer | string) => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      record.stdoutBytes += data.byteLength;
      record.stdoutWrite = record.stdoutWrite.then(() => appendFile(record.stdoutPath, data));
      this.notify(record);
    });
    record.child.stderr.on('data', (chunk: Buffer | string) => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      record.stderrBytes += data.byteLength;
      record.stderrWrite = record.stderrWrite.then(() => appendFile(record.stderrPath, data));
      this.notify(record);
    });
  }

  private attachLifecycle(record: ProcessRecord): void {
    record.child.once('error', (error) => {
      record.error = error.message;
      void this.finalize(record, null, null, 'failed');
    });
    record.child.once('close', (exitCode, signal) => {
      void this.finalize(record, exitCode, signal, record.stopReason ?? 'exited');
    });
  }

  private async waitForSpawn(record: ProcessRecord): Promise<void> {
    if (record.child.pid !== undefined) return;
    await Promise.race([
      new Promise<void>((resolvePromise) => record.child.once('spawn', () => resolvePromise())),
      record.done,
    ]);
  }

  private async stopRecord(record: ProcessRecord, reason: StopReason): Promise<void> {
    if (record.status !== 'running') return;
    if (!record.stopReason) record.stopReason = reason;
    if (!record.stopPromise) {
      record.stopPromise = terminateProcessTree(record.child).catch((error) => {
        record.error = error instanceof Error ? error.message : String(error);
      });
      this.notify(record);
    }
    await record.stopPromise;
    await Promise.race([record.done, delay(PROCESS_CLOSE_GRACE_MS)]);
    if (!record.finalized) {
      record.child.kill('SIGKILL');
      await record.done;
    }
  }

  private async finalize(
    record: ProcessRecord,
    exitCode: number | null,
    signal: NodeJS.Signals | null,
    status: ProcessRuntimeStatus,
  ): Promise<void> {
    if (record.finalized) return;
    record.finalized = true;
    if (record.timeout) clearTimeout(record.timeout);
    if (record.parentSignal && record.abortListener) {
      record.parentSignal.removeEventListener('abort', record.abortListener);
    }
    await record.stopPromise?.catch(() => undefined);
    await Promise.allSettled([record.stdoutWrite, record.stderrWrite]);
    record.status = record.stopReason ?? status;
    record.exitCode = exitCode;
    record.signal = signal;
    record.finishedAt = this.now();
    record.expiresAt = new Date(record.finishedAt.getTime() + this.retentionMs);
    record.resolveDone();
    this.notify(record);
  }

  private async snapshot(
    record: ProcessRecord,
    cursor: ProcessOutputCursor,
    maxProjectionBytes = this.maxProjectionBytes,
  ): Promise<ProcessRuntimeSnapshot> {
    await Promise.allSettled([record.stdoutWrite, record.stderrWrite]);
    const [stdout, stderr] = await Promise.all([
      readProjection(record.stdoutPath, cursor.stdoutBytes, record.stdoutBytes, maxProjectionBytes),
      readProjection(record.stderrPath, cursor.stderrBytes, record.stderrBytes, maxProjectionBytes),
    ]);
    return {
      processId: record.processId,
      ...(record.child.pid === undefined ? {} : { pid: record.child.pid }),
      status: record.status,
      exitCode: record.exitCode,
      signal: record.signal,
      timedOut: record.status === 'timed-out',
      startedAt: record.startedAt.toISOString(),
      ...(record.finishedAt === undefined
        ? {}
        : { finishedAt: record.finishedAt.toISOString() }),
      ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt.toISOString() }),
      output: { stdout, stderr },
      nextCursor: {
        stdoutBytes: record.stdoutBytes,
        stderrBytes: record.stderrBytes,
      },
      ...(record.error === undefined ? {} : { error: record.error }),
    };
  }

  private ownedRecord(sessionIdValue: string, processIdValue: string): ProcessRecord {
    const sessionId = requiredText(sessionIdValue, 'sessionId');
    const processId = requiredText(processIdValue, 'processId');
    const record = this.records.get(processId);
    if (!record || record.sessionId !== sessionId) {
      throw new Error('Process handle was not found for the current Session.');
    }
    return record;
  }

  private async waitForChange(record: ProcessRecord, waitMs: number): Promise<void> {
    const revision = record.revision;
    await new Promise<void>((resolvePromise) => {
      const finish = () => {
        clearTimeout(timer);
        record.waiters.delete(finish);
        resolvePromise();
      };
      record.waiters.add(finish);
      const timer = setTimeout(finish, waitMs);
      timer.unref?.();
      if (record.revision !== revision) finish();
    });
  }

  private notify(record: ProcessRecord): void {
    record.revision += 1;
    for (const waiter of [...record.waiters]) waiter();
  }

  private async sweepExpired(): Promise<void> {
    const now = this.now().getTime();
    const expired = [...this.records.values()].filter(
      (record) => record.expiresAt !== undefined && record.expiresAt.getTime() <= now,
    );
    await Promise.all(
      expired.map(async (record) => {
        this.records.delete(record.processId);
        await rm(record.directory, { recursive: true, force: true });
      }),
    );
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Process Runtime is closed.');
  }
}

async function readProjection(
  path: string,
  fromByte: number,
  totalBytes: number,
  maxBytesValue: number,
): Promise<ProcessOutputProjection> {
  const available = Math.max(0, totalBytes - fromByte);
  const maxBytes = Math.max(32, maxBytesValue);
  if (available === 0) {
    return {
      text: '',
      fromByte,
      toByte: fromByte,
      totalBytes,
      truncated: false,
    };
  }
  if (available <= maxBytes) {
    return {
      text: (await readBytes(path, fromByte, available)).toString('utf8'),
      fromByte,
      toByte: totalBytes,
      totalBytes,
      truncated: false,
    };
  }

  const provisionalOmitted = Math.max(0, available - maxBytes);
  const marker = `\n… ${provisionalOmitted} bytes omitted …\n`;
  const markerBytes = Math.min(maxBytes - 2, Buffer.byteLength(marker));
  const contentBudget = Math.max(2, maxBytes - markerBytes);
  const headBytes = Math.max(1, Math.floor(contentBudget * 0.6));
  const tailBytes = Math.max(1, contentBudget - headBytes);
  const omittedBytes = available - headBytes - tailBytes;
  const finalMarker = `\n… ${omittedBytes} bytes omitted …\n`;
  const finalMarkerBytes = Buffer.byteLength(finalMarker);
  const overflow = Math.max(0, headBytes + tailBytes + finalMarkerBytes - maxBytes);
  const adjustedTailBytes = Math.max(1, tailBytes - overflow);
  const adjustedOmittedBytes = available - headBytes - adjustedTailBytes;
  const [head, tail] = await Promise.all([
    readBytes(path, fromByte, headBytes),
    readBytes(path, totalBytes - adjustedTailBytes, adjustedTailBytes),
  ]);
  return {
    text: `${head.toString('utf8')}\n… ${adjustedOmittedBytes} bytes omitted …\n${tail.toString('utf8')}`,
    fromByte,
    toByte: totalBytes,
    totalBytes,
    truncated: true,
    omittedBytes: adjustedOmittedBytes,
  };
}

async function readBytes(path: string, offset: number, length: number): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function terminateProcessTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) {
    child.kill();
    return;
  }
  if (process.platform === 'win32') {
    const exitCode = await taskkill(pid, true);
    if (exitCode === 0) return;
    child.kill();
    throw new Error(
      `Could not confirm complete Windows process-tree cleanup for PID ${pid} (taskkill exit ${String(exitCode)}).`,
    );
  }

  signalProcessGroup(pid, 'SIGTERM', child);
  await delay(PROCESS_TREE_KILL_GRACE_MS);
  if (child.exitCode === null && child.signalCode === null) {
    signalProcessGroup(pid, 'SIGKILL', child);
  }
}

async function taskkill(pid: number, includeTree: boolean): Promise<number | null> {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  const executable = systemRoot ? join(systemRoot, 'System32', 'taskkill.exe') : 'taskkill.exe';
  return await new Promise<number | null>((resolvePromise) => {
    const killer = spawn(
      executable,
      ['/PID', String(pid), ...(includeTree ? ['/T'] : []), '/F'],
      {
        env: safeProcessEnvironment(),
        stdio: 'ignore',
        windowsHide: true,
      },
    );
    let settled = false;
    const settle = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      resolvePromise(exitCode);
    };
    killer.once('error', () => settle(null));
    killer.once('close', settle);
  });
}

function signalProcessGroup(
  pid: number,
  signal: NodeJS.Signals,
  fallback: ChildProcessWithoutNullStreams,
): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') fallback.kill(signal);
  }
}

export function safeProcessEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const allowed = [
    'COMSPEC',
    'HOME',
    'LANG',
    'LC_ALL',
    'LOCALAPPDATA',
    'PATH',
    'PATHEXT',
    'SYSTEMDRIVE',
    'SYSTEMROOT',
    'TEMP',
    'TMP',
    'TMPDIR',
    'USERPROFILE',
    'WINDIR',
  ] as const;
  return Object.fromEntries(
    allowed.flatMap((key) => {
      const value = environment[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );
}

function normalizeCursor(
  cursor: ProcessOutputCursor | undefined,
  record: ProcessRecord,
): ProcessOutputCursor {
  const normalized = cursor ?? { stdoutBytes: 0, stderrBytes: 0 };
  if (
    !Number.isSafeInteger(normalized.stdoutBytes) ||
    normalized.stdoutBytes < 0 ||
    normalized.stdoutBytes > record.stdoutBytes ||
    !Number.isSafeInteger(normalized.stderrBytes) ||
    normalized.stderrBytes < 0 ||
    normalized.stderrBytes > record.stderrBytes
  ) {
    throw new Error('Process output cursor is outside the available spool range.');
  }
  return normalized;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) || value <= 0
    ? fallback
    : Math.floor(value);
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) || value < 0
    ? fallback
    : Math.floor(value);
}

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
