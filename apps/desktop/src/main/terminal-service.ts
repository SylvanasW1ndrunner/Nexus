import { exec } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import type { PythonRunResult, TerminalRunRequest, TerminalSession } from '@dbagent/shared';

const execAsync = promisify(exec);

export class TerminalService {
  private readonly sessions = new Map<string, TerminalSession>();

  list(): TerminalSession[] {
    return [...this.sessions.values()];
  }

  create(input: { cwd?: string; name?: string } = {}): TerminalSession {
    const id = randomUUID();
    const session: TerminalSession = {
      id,
      name: input.name?.trim() || `Terminal ${this.sessions.size + 1}`,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      createdAt: new Date().toISOString(),
    };
    this.sessions.set(id, session);
    return session;
  }

  close(id: string): { id: string } {
    this.sessions.delete(id);
    return { id };
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
