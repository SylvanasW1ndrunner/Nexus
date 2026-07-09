import { spawn } from 'node:child_process';
import { basename } from 'node:path';
import type { AgentToolContext, ToolRegistry } from '@dbagent/core-agent';
import { optionalPositiveInteger, optionalString, requireString } from './validation.js';

export const DEFAULT_SHELL_COMMAND_WHITELIST = [
  'awk',
  'cat',
  'cd',
  'dir',
  'echo',
  'find',
  'git',
  'grep',
  'head',
  'ls',
  'node',
  'npm',
  'pip',
  'pnpm',
  'pwd',
  'python',
  'python3',
  'sed',
  'tail',
  'type',
  'uv',
  'wc',
  'where',
  'which',
];

export type ShellCommandPolicy = {
  whitelist: string[];
  blacklist: Array<{ id: string; pattern: RegExp; reason: string }>;
  timeoutMs: number;
  maxOutputBytes: number;
  maskEnvPatterns: string[];
};

export type ShellCommandDecision = {
  action: 'allow' | 'approval-required' | 'deny';
  mode: AgentToolContext['session']['mode'];
  reasons: string[];
  autoAllowed: boolean;
  matchedBlacklistIds: string[];
};

export type ShellCommandRunRequest = {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  policy?: Partial<ShellCommandPolicy>;
};

export type ShellCommandRunResult = {
  command: string;
  cwd: string;
  exitCode: number | null;
  signal?: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  elapsedMs: number;
  timedOut?: boolean;
  aborted?: boolean;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  timeoutMs?: number;
  maskedEnvKeys: string[];
};

export type ShellCommandToolDependencies = {
  registry: ToolRegistry;
  policy?: Partial<ShellCommandPolicy>;
};

export function registerShellCommandTool(dependencies: ShellCommandToolDependencies): void {
  const policy = normalizeShellCommandPolicy(dependencies.policy);
  dependencies.registry.register(
    {
      name: 'run_shell_command',
      description:
        'Run a shell command in a managed child process. High-risk commands require approval and dangerous patterns are blocked.',
      inputSchema: objectSchema({
        command: { type: 'string' },
        cwd: { type: 'string' },
        timeoutMs: { type: 'number' },
        maxOutputBytes: { type: 'number' },
      }),
      dangerLevel: 'high',
      readonly: false,
      source: 'official',
      sourceId: 'official.shell-command',
      originalName: 'run_shell_command',
    },
    async (args, context) => {
      const command = requireString(args, 'command');
      const cwd = optionalString(args, 'cwd');
      const timeoutMs = optionalPositiveInteger(args, 'timeoutMs', policy.timeoutMs) ?? policy.timeoutMs;
      const maxOutputBytes =
        optionalPositiveInteger(args, 'maxOutputBytes', policy.maxOutputBytes) ?? policy.maxOutputBytes;
      const decision = evaluateShellCommandPolicy(command, context, policy);
      if (decision.action === 'deny') {
        throw new Error(`Shell command blocked. ${decision.reasons.join(' ')}`);
      }
      if (decision.action === 'approval-required') {
        throw new Error(`Shell command requires explicit approval. ${decision.reasons.join(' ')}`);
      }
      const runRequest: ShellCommandRunRequest = {
        command,
        timeoutMs,
        maxOutputBytes,
        policy,
      };
      if (cwd !== undefined) runRequest.cwd = cwd;
      if (context.signal !== undefined) runRequest.signal = context.signal;
      const result = await runShellCommand(runRequest);
      return { ...result, policy: decision };
    },
  );
}

export function evaluateShellCommandPolicy(
  command: string,
  context: AgentToolContext,
  policyInput: Partial<ShellCommandPolicy> = {},
): ShellCommandDecision {
  const policy = normalizeShellCommandPolicy(policyInput);
  const matchedBlacklist = policy.blacklist.filter((entry) => entry.pattern.test(command));
  if (matchedBlacklist.length) {
    return {
      action: 'deny',
      mode: context.session.mode,
      reasons: matchedBlacklist.map((entry) => entry.reason),
      autoAllowed: false,
      matchedBlacklistIds: matchedBlacklist.map((entry) => entry.id),
    };
  }

  if (context.session.mode === 'readonly') {
    return {
      action: 'deny',
      mode: context.session.mode,
      reasons: ['readonly mode does not allow shell command execution.'],
      autoAllowed: false,
      matchedBlacklistIds: [],
    };
  }

  const autoAllowed = isWhitelistedShellCommand(command, policy.whitelist);
  if (context.session.mode === 'full-auto') {
    return { action: 'allow', mode: context.session.mode, reasons: [], autoAllowed, matchedBlacklistIds: [] };
  }
  if (context.session.mode === 'auto' && autoAllowed) {
    return { action: 'allow', mode: context.session.mode, reasons: [], autoAllowed, matchedBlacklistIds: [] };
  }
  if (isApprovedToolContext(context, 'run_shell_command')) {
    return { action: 'allow', mode: context.session.mode, reasons: [], autoAllowed, matchedBlacklistIds: [] };
  }

  return {
    action: 'approval-required',
    mode: context.session.mode,
    reasons:
      context.session.mode === 'auto'
        ? ['command is not fully covered by the shell auto-execution whitelist.']
        : ['ask mode requires user approval for every shell command.'],
    autoAllowed,
    matchedBlacklistIds: [],
  };
}

export async function runShellCommand(request: ShellCommandRunRequest): Promise<ShellCommandRunResult> {
  const policy = normalizeShellCommandPolicy(request.policy);
  const cwd = request.cwd ?? process.cwd();
  const output = createShellOutputCapture(request.maxOutputBytes ?? policy.maxOutputBytes);
  const env = buildMaskedEnv(request.env ?? process.env, policy.maskEnvPatterns);
  const startedAt = Date.now();
  let timedOut = false;
  let aborted = false;

  if (request.signal?.aborted) {
    throw new Error('Shell command execution was aborted before launch.');
  }

  return new Promise<ShellCommandRunResult>((resolve) => {
    const child = spawn(request.command, {
      cwd,
      env: env.env,
      shell: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let timeout: ReturnType<typeof setTimeout> | undefined;
    let forceKillTimeout: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      if (forceKillTimeout) clearTimeout(forceKillTimeout);
      request.signal?.removeEventListener('abort', abortFromSignal);
    };
    const killChild = () => {
      if (!child.killed) child.kill();
      forceKillTimeout = setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 2_000);
    };
    const abortFromSignal = () => {
      aborted = true;
      killChild();
    };

    child.stdout?.on('data', (chunk: Buffer) => output.appendStdout(chunk));
    child.stderr?.on('data', (chunk: Buffer) => output.appendStderr(chunk));
    child.once('error', (error) => output.appendStderr(Buffer.from(error.message)));
    child.once('close', (exitCode, signal) => {
      cleanup();
      resolve({
        command: request.command,
        cwd,
        exitCode,
        signal,
        stdout: output.stdout(),
        stderr: output.stderr(),
        elapsedMs: Date.now() - startedAt,
        ...(timedOut ? { timedOut: true, timeoutMs: request.timeoutMs ?? policy.timeoutMs } : {}),
        ...(aborted ? { aborted: true } : {}),
        ...(output.stdoutTruncated() ? { stdoutTruncated: true } : {}),
        ...(output.stderrTruncated() ? { stderrTruncated: true } : {}),
        maskedEnvKeys: env.maskedKeys,
      });
    });

    if (request.timeoutMs !== 0) {
      timeout = setTimeout(() => {
        timedOut = true;
        killChild();
      }, request.timeoutMs ?? policy.timeoutMs);
    }
    request.signal?.addEventListener('abort', abortFromSignal, { once: true });
  });
}

export function normalizeShellCommandPolicy(input: Partial<ShellCommandPolicy> = {}): ShellCommandPolicy {
  return {
    whitelist: normalizeCommandNames(input.whitelist ?? DEFAULT_SHELL_COMMAND_WHITELIST),
    blacklist: input.blacklist ?? defaultShellCommandBlacklist(),
    timeoutMs: Math.max(1, Math.floor(input.timeoutMs ?? 60_000)),
    maxOutputBytes: Math.max(1, Math.floor(input.maxOutputBytes ?? 100_000)),
    maskEnvPatterns: input.maskEnvPatterns ?? ['*KEY*', '*SECRET*', '*PASSWORD*', '*TOKEN*'],
  };
}

export function isWhitelistedShellCommand(command: string, whitelist: string[]): boolean {
  const allowed = new Set(normalizeCommandNames(whitelist));
  const segments = splitShellSegments(command);
  if (segments.length === 0) return false;
  return segments.every((segment) => {
    if (/[<>]/u.test(segment)) return false;
    const executable = firstExecutableToken(segment);
    return executable !== undefined && allowed.has(normalizeCommandName(executable));
  });
}

function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    const next = command[index + 1];
    if ((char === '"' || char === "'") && command[index - 1] !== '\\') {
      quote = quote === char ? undefined : quote ?? char;
      current += char;
      continue;
    }
    if (!quote) {
      if ((char === '&' && next === '&') || (char === '|' && next === '|')) {
        pushSegment(segments, current);
        current = '';
        index += 1;
        continue;
      }
      if (char === ';' || char === '|') {
        pushSegment(segments, current);
        current = '';
        continue;
      }
    }
    current += char;
  }
  pushSegment(segments, current);
  return segments;
}

function pushSegment(segments: string[], value: string): void {
  const trimmed = value.trim();
  if (trimmed) segments.push(trimmed);
}

function defaultShellCommandBlacklist(): ShellCommandPolicy['blacklist'] {
  return [
    {
      id: 'recursive-root-delete',
      pattern: /\brm\s+-[^\r\n;|&]*r[^\r\n;|&]*f\s+(?:\/|~|[A-Za-z]:\\?)(?:\s|$)/iu,
      reason: 'recursive root or home deletion is blocked.',
    },
    { id: 'privilege-escalation', pattern: /\bsudo\b/iu, reason: 'sudo is blocked.' },
    {
      id: 'system-shutdown',
      pattern: /\b(?:shutdown|reboot|poweroff)\b/iu,
      reason: 'system shutdown commands are blocked.',
    },
    { id: 'format-filesystem', pattern: /\bmkfs(?:\.\w+)?\b/iu, reason: 'filesystem formatting is blocked.' },
    { id: 'raw-disk-write', pattern: /\bdd\s+/iu, reason: 'raw disk writes are blocked.' },
    { id: 'device-redirection', pattern: />+\s*\/dev\//iu, reason: 'device redirection is blocked.' },
    {
      id: 'download-pipe-shell',
      pattern: /\b(?:curl|wget|iwr|Invoke-WebRequest)\b[\s\S]*(?:\||;|&&)\s*(?:sh|bash|powershell|pwsh|iex)\b/iu,
      reason: 'download-and-execute shell pipelines are blocked.',
    },
    {
      id: 'powershell-force-delete',
      pattern: /\b(?:Remove-Item|del|erase)\b[\s\S]*-(?:Recurse|r)\b[\s\S]*-(?:Force|f)\b/iu,
      reason: 'forced recursive deletion is blocked.',
    },
    {
      id: 'execution-policy',
      pattern: /\bSet-ExecutionPolicy\b/iu,
      reason: 'changing PowerShell execution policy is blocked.',
    },
  ];
}

function firstExecutableToken(segment: string): string | undefined {
  const trimmed = segment.trim();
  if (!trimmed) return undefined;
  const match = /^"([^"]+)"|^'([^']+)'|^(\S+)/u.exec(trimmed);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function normalizeCommandNames(values: string[]): string[] {
  return [...new Set(values.map(normalizeCommandName).filter(Boolean))];
}

function normalizeCommandName(value: string): string {
  const base = basename(value.replaceAll('\\', '/')).toLowerCase();
  return base.replace(/\.(?:exe|cmd|bat|ps1)$/iu, '');
}

function buildMaskedEnv(
  input: NodeJS.ProcessEnv,
  maskPatterns: string[],
): { env: NodeJS.ProcessEnv; maskedKeys: string[] } {
  const env: NodeJS.ProcessEnv = {};
  const maskedKeys: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (matchesMaskPattern(key, maskPatterns)) {
      env[key] = '[masked]';
      maskedKeys.push(key);
    } else {
      env[key] = value;
    }
  }
  return { env, maskedKeys: maskedKeys.sort((left, right) => left.localeCompare(right)) };
}

function matchesMaskPattern(key: string, patterns: string[]): boolean {
  const normalized = key.toUpperCase();
  return patterns.some((pattern) => {
    const escaped = pattern.toUpperCase().replace(/[.+?^${}()|[\]\\]/gu, '\\$&').replaceAll('*', '.*');
    return new RegExp(`^${escaped}$`, 'u').test(normalized);
  });
}

function createShellOutputCapture(limitBytes: number): {
  appendStdout(chunk: Buffer): void;
  appendStderr(chunk: Buffer): void;
  stdout(): string;
  stderr(): string;
  stdoutTruncated(): boolean;
  stderrTruncated(): boolean;
} {
  let stdout = '';
  let stderr = '';
  let stdoutTruncated = false;
  let stderrTruncated = false;

  const trim = (value: string): { value: string; truncated: boolean } => {
    if (Buffer.byteLength(value) <= limitBytes) return { value, truncated: false };
    const chars = [...value];
    let output = '';
    for (let index = chars.length - 1; index >= 0; index -= 1) {
      const next = `${chars[index]}${output}`;
      if (Buffer.byteLength(next) > limitBytes) break;
      output = next;
    }
    return { value: output, truncated: true };
  };

  return {
    appendStdout(chunk) {
      const trimmed = trim(stdout + chunk.toString('utf8'));
      stdout = trimmed.value;
      stdoutTruncated = stdoutTruncated || trimmed.truncated;
    },
    appendStderr(chunk) {
      const trimmed = trim(stderr + chunk.toString('utf8'));
      stderr = trimmed.value;
      stderrTruncated = stderrTruncated || trimmed.truncated;
    },
    stdout: () => stdout,
    stderr: () => stderr,
    stdoutTruncated: () => stdoutTruncated,
    stderrTruncated: () => stderrTruncated,
  };
}

function isApprovedToolContext(context: unknown, toolName: string): boolean {
  if (!context || typeof context !== 'object') return false;
  const approval = (context as { approval?: unknown }).approval;
  if (!approval || typeof approval !== 'object') return false;
  const record = approval as { granted?: unknown; toolName?: unknown };
  return record.granted === true && record.toolName === toolName;
}

function objectSchema(properties: Record<string, Record<string, unknown>>): Record<string, unknown> {
  return {
    type: 'object',
    properties,
  };
}
