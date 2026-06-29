import { exec } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import * as pty from 'node-pty';
import type {
  PythonRunResult,
  TerminalReadRequest,
  TerminalReadResult,
  TerminalResizeRequest,
  TerminalRunRequest,
  TerminalSession,
  TerminalWriteRequest,
} from '@dbagent/shared';

const execAsync = promisify(exec);

type TerminalRuntime = {
  process: pty.IPty;
  output: string;
  outputBaseCursor: number;
  recentInputEchoNeedles: string[];
  staleInputEchoNeedles: string[];
  status: 'running' | 'exited';
  exitCode?: number | null;
};

export class TerminalService {
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly runtimes = new Map<string, TerminalRuntime>();

  constructor(private options: { defaultShell?: string; maxOutputChars?: number } = {}) {}

  configure(options: { defaultShell?: string; maxOutputChars?: number }): void {
    this.options = { ...this.options, ...options };
  }

  list(): TerminalSession[] {
    return [...this.sessions.values()];
  }

  create(input: { cwd?: string; name?: string } = {}): TerminalSession {
    const id = randomUUID();
    const shellCandidates = getShellCandidates(this.options.defaultShell);
    const cwd = input.cwd ?? process.cwd();
    const { child, shell } = spawnFirstAvailableShell(shellCandidates, cwd);
    const session: TerminalSession = {
      id,
      name: input.name?.trim() || `Terminal ${this.sessions.size + 1}`,
      cwd,
      createdAt: new Date().toISOString(),
      shell: shell.label,
      status: 'running',
      ...(child.pid ? { pid: child.pid } : {}),
    };
    const runtime: TerminalRuntime = {
      process: child,
      output: '',
      outputBaseCursor: 0,
      recentInputEchoNeedles: [],
      staleInputEchoNeedles: [],
      status: 'running',
    };
    child.onData((data) => {
      appendTerminalOutput(runtime, data, this.options.maxOutputChars);
    });
    child.onExit(({ exitCode }) => {
      runtime.status = 'exited';
      runtime.exitCode = exitCode;
      const current = this.sessions.get(id);
      if (current) this.sessions.set(id, { ...current, status: 'exited', lastExitCode: exitCode });
    });
    this.sessions.set(id, session);
    this.runtimes.set(id, runtime);
    return session;
  }

  close(id: string): { id: string } {
    const runtime = this.runtimes.get(id);
    if (runtime?.status === 'running') runtime.process.kill();
    this.runtimes.delete(id);
    this.sessions.delete(id);
    return { id };
  }

  clear(id: string): { id: string } {
    const runtime = this.runtimes.get(id);
    if (!runtime) throw new Error('Terminal session does not exist.');
    runtime.output = '';
    runtime.outputBaseCursor = 0;
    return { id };
  }

  resize(request: TerminalResizeRequest): { id: string; cols: number; rows: number } {
    const runtime = this.runtimes.get(request.terminalId);
    if (!runtime || runtime.status !== 'running')
      throw new Error('Terminal session is not running.');
    const cols = Math.max(2, Math.floor(request.cols));
    const rows = Math.max(1, Math.floor(request.rows));
    runtime.process.resize(cols, rows);
    return { id: request.terminalId, cols, rows };
  }

  write(request: TerminalWriteRequest): { id: string } {
    const runtime = this.runtimes.get(request.terminalId);
    if (!runtime || runtime.status !== 'running')
      throw new Error('Terminal session is not running.');
    const command = request.data.replace(/[\r\n]+$/, '').trim();
    if (command) {
      if (runtime.outputBaseCursor > 0) {
        runtime.staleInputEchoNeedles = boundedUnique([
          ...runtime.staleInputEchoNeedles,
          ...runtime.recentInputEchoNeedles,
        ]);
      }
      runtime.recentInputEchoNeedles = boundedUnique([
        ...runtime.recentInputEchoNeedles,
        ...extractInputEchoNeedles(command),
      ]);
    }
    runtime.process.write(request.data);
    const current = this.sessions.get(request.terminalId);
    if (current) {
      this.sessions.set(
        request.terminalId,
        command ? { ...current, lastCommand: command } : current,
      );
    }
    return { id: request.terminalId };
  }

  read(request: TerminalReadRequest): TerminalReadResult {
    const runtime = this.runtimes.get(request.terminalId);
    if (!runtime) throw new Error('Terminal session does not exist.');
    if (request.cursor > 0 && request.cursor < runtime.outputBaseCursor) {
      return {
        terminalId: request.terminalId,
        chunk: '',
        cursor: runtime.outputBaseCursor,
        status: runtime.status,
        ...(runtime.exitCode !== undefined ? { exitCode: runtime.exitCode } : {}),
      };
    }
    const cursor = Math.max(runtime.outputBaseCursor, request.cursor);
    const start = cursor - runtime.outputBaseCursor;
    const nextCursor = runtime.outputBaseCursor + runtime.output.length;
    return {
      terminalId: request.terminalId,
      chunk: runtime.output.slice(start),
      cursor: nextCursor,
      status: runtime.status,
      ...(runtime.exitCode !== undefined ? { exitCode: runtime.exitCode } : {}),
    };
  }

  async run(request: TerminalRunRequest): Promise<PythonRunResult> {
    const session =
      this.sessions.get(request.terminalId) ?? this.create(request.cwd ? { cwd: request.cwd } : {});
    const cwd = request.cwd ?? session.cwd ?? process.cwd();
    const startedAt = Date.now();
    try {
      const output = await execAsync(request.command, {
        cwd,
        timeout: request.timeoutMs ?? 30_000,
        maxBuffer: 1024 * 1024 * 4,
      });
      this.sessions.set(session.id, {
        ...session,
        cwd,
        lastCommand: request.command,
        lastExitCode: 0,
      });
      return {
        command: request.command,
        cwd,
        exitCode: 0,
        stdout: output.stdout,
        stderr: output.stderr,
        elapsedMs: Date.now() - startedAt,
      };
    } catch (error) {
      const failed = error as NodeJS.ErrnoException & {
        stdout?: string;
        stderr?: string;
        code?: number | null;
      };
      this.sessions.set(session.id, {
        ...session,
        cwd,
        lastCommand: request.command,
        lastExitCode: typeof failed.code === 'number' ? failed.code : null,
      });
      return {
        command: request.command,
        cwd,
        exitCode: typeof failed.code === 'number' ? failed.code : null,
        stdout: failed.stdout ?? '',
        stderr: failed.stderr ?? failed.message,
        elapsedMs: Date.now() - startedAt,
      };
    }
  }
}

type ShellCandidate = { command: string; args: string[]; label: string };

function getShellCandidates(configuredShell?: string): ShellCandidate[] {
  const systemShell = getSystemShell();
  if (configuredShell?.trim()) {
    const command = configuredShell.trim();
    if (command !== systemShell.command)
      return [{ command, args: [], label: command.split(/[\\/]/).at(-1) ?? command }, systemShell];
  }
  return [systemShell];
}

function getSystemShell(): ShellCandidate {
  if (process.platform === 'win32') {
    return {
      command: 'powershell.exe',
      args: ['-NoLogo', '-NoProfile'],
      label: 'powershell.exe',
    };
  }
  const shell = process.env.SHELL ?? '/bin/sh';
  return {
    command: shell,
    args: [],
    label: shell.split('/').at(-1) ?? shell,
  };
}

function spawnFirstAvailableShell(
  shells: ShellCandidate[],
  cwd: string,
): { child: pty.IPty; shell: ShellCandidate } {
  let lastError: unknown;
  for (const shell of shells) {
    try {
      return {
        shell,
        child: pty.spawn(shell.command, shell.args, {
          cols: 100,
          rows: 30,
          cwd,
          env: process.env,
          name: process.platform === 'win32' ? 'xterm-256color' : 'xterm-color',
          useConptyDll: process.platform === 'win32',
        }),
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Unable to start terminal shell.');
}

function appendTerminalOutput(
  runtime: TerminalRuntime,
  data: string,
  maxOutputChars?: number,
): void {
  runtime.output += redactStaleInputEchoes(data, runtime.staleInputEchoNeedles);
  const limit = Math.max(1, Math.floor(maxOutputChars ?? 1024 * 1024));
  if (runtime.output.length <= limit) return;

  const overflow = runtime.output.length - limit;
  const trimStart = terminalTrimStart(runtime.output, overflow);
  runtime.output = runtime.output.slice(trimStart);
  runtime.outputBaseCursor += trimStart;
}

function terminalTrimStart(output: string, overflow: number): number {
  const newlineIndex = output.indexOf('\n', overflow);
  const carriageReturnIndex = output.indexOf('\r', overflow);
  const boundary = [newlineIndex, carriageReturnIndex]
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];
  if (boundary === undefined) return overflow;
  const nextStart = boundary + 1;
  return output.length - nextStart > 0 ? nextStart : overflow;
}

function extractInputEchoNeedles(command: string): string[] {
  const needles = [command];
  const firstWhitespace = command.search(/\s/);
  if (firstWhitespace >= 0) needles.push(command.slice(firstWhitespace).trim());
  return needles.map((needle) => needle.slice(0, 80)).filter((needle) => needle.length >= 8);
}

function redactStaleInputEchoes(data: string, staleNeedles: string[]): string {
  return staleNeedles.reduce(
    (text, needle) => text.replaceAll(needle, '[trimmed-input-echo]'),
    data,
  );
}

function boundedUnique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].slice(-20);
}
