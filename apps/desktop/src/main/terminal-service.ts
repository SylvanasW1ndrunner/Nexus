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
  status: 'running' | 'exited';
  exitCode?: number | null;
};

export class TerminalService {
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly runtimes = new Map<string, TerminalRuntime>();

  constructor(private options: { defaultShell?: string } = {}) {}

  configure(options: { defaultShell?: string }): void {
    this.options = { ...this.options, ...options };
  }

  list(): TerminalSession[] {
    return [...this.sessions.values()];
  }

  create(input: { cwd?: string; name?: string } = {}): TerminalSession {
    const id = randomUUID();
    const shell = getDefaultShell(this.options.defaultShell);
    const cwd = input.cwd ?? process.cwd();
    const child = pty.spawn(shell.command, shell.args, {
      cols: 100,
      rows: 30,
      cwd,
      env: process.env,
      name: process.platform === 'win32' ? 'xterm-256color' : 'xterm-color',
      useConptyDll: process.platform === 'win32',
    });
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
      status: 'running',
    };
    child.onData((data) => {
      runtime.output += data;
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
    return { id };
  }

  resize(request: TerminalResizeRequest): { id: string; cols: number; rows: number } {
    const runtime = this.runtimes.get(request.terminalId);
    if (!runtime || runtime.status !== 'running') throw new Error('Terminal session is not running.');
    const cols = Math.max(2, Math.floor(request.cols));
    const rows = Math.max(1, Math.floor(request.rows));
    runtime.process.resize(cols, rows);
    return { id: request.terminalId, cols, rows };
  }

  write(request: TerminalWriteRequest): { id: string } {
    const runtime = this.runtimes.get(request.terminalId);
    if (!runtime || runtime.status !== 'running') throw new Error('Terminal session is not running.');
    runtime.process.write(request.data);
    const current = this.sessions.get(request.terminalId);
    if (current) {
      const command = request.data.replace(/[\r\n]+$/, '').trim();
      this.sessions.set(request.terminalId, command ? { ...current, lastCommand: command } : current);
    }
    return { id: request.terminalId };
  }

  read(request: TerminalReadRequest): TerminalReadResult {
    const runtime = this.runtimes.get(request.terminalId);
    if (!runtime) throw new Error('Terminal session does not exist.');
    const cursor = Math.max(0, request.cursor);
    const nextCursor = runtime.output.length;
    return {
      terminalId: request.terminalId,
      chunk: runtime.output.slice(cursor),
      cursor: nextCursor,
      status: runtime.status,
      ...(runtime.exitCode !== undefined ? { exitCode: runtime.exitCode } : {}),
    };
  }

  async run(request: TerminalRunRequest): Promise<PythonRunResult> {
    const session = this.sessions.get(request.terminalId) ?? this.create(request.cwd ? { cwd: request.cwd } : {});
    const cwd = request.cwd ?? session.cwd ?? process.cwd();
    const startedAt = Date.now();
    try {
      const output = await execAsync(request.command, {
        cwd,
        timeout: request.timeoutMs ?? 30_000,
        maxBuffer: 1024 * 1024 * 4,
      });
      this.sessions.set(session.id, { ...session, cwd, lastCommand: request.command, lastExitCode: 0 });
      return {
        command: request.command,
        cwd,
        exitCode: 0,
        stdout: output.stdout,
        stderr: output.stderr,
        elapsedMs: Date.now() - startedAt,
      };
    } catch (error) {
      const failed = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | null };
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

function getDefaultShell(configuredShell?: string): { command: string; args: string[]; label: string } {
  if (configuredShell?.trim()) {
    const command = configuredShell.trim();
    return {
      command,
      args: [],
      label: command.split(/[\\/]/).at(-1) ?? command,
    };
  }
  if (process.platform === 'win32') {
    return {
      command: process.env.ComSpec ?? 'cmd.exe',
      args: [],
      label: process.env.ComSpec?.split(/[\\/]/).at(-1) ?? 'cmd.exe',
    };
  }
  const shell = process.env.SHELL ?? '/bin/sh';
  return {
    command: shell,
    args: [],
    label: shell.split('/').at(-1) ?? shell,
  };
}
