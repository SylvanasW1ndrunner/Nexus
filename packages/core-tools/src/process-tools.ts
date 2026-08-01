import {
  createAgentToolResultEnvelope,
  type AgentToolCompletionEvidence,
  type ToolRegistry,
} from '@dbagent/core-agent';
import { stat } from 'node:fs/promises';
import { WorkspaceBoundary } from './workspace-tools.js';
import {
  type ProcessOutputCursor,
  type ProcessRuntime,
  type ProcessRuntimeSnapshot,
} from './process-runtime.js';
import { optionalPositiveInteger, optionalString, requireString } from './validation.js';

export type ProcessToolOptions = {
  rootPath: string;
  runtime: ProcessRuntime;
  defaultTimeoutMs?: number;
  maxTimeoutMs?: number;
  maxPollWaitMs?: number;
};

export function registerProcessTools(registry: ToolRegistry, options: ProcessToolOptions): void {
  const workspace = new WorkspaceBoundary(options.rootPath);
  const defaultTimeoutMs = options.defaultTimeoutMs ?? 60_000;
  const maxTimeoutMs = options.maxTimeoutMs ?? 30 * 60_000;
  const maxPollWaitMs = options.maxPollWaitMs ?? 30_000;

  registry.register(
    {
      name: 'process_exec',
      title: 'Run process',
      aliases: ['shell', 'bash', 'terminal', 'command', '运行命令', '终端'],
      tags: ['process', 'shell', 'workspace'],
      description:
        'Run a command inside the project. Set background=true for long-running or interactive work, then use process_poll/process_write/process_terminate with the returned handle.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Command line to execute.' },
          cwd: { type: 'string', description: 'Project-relative working directory.' },
          background: { type: 'boolean' },
          timeoutMs: { type: 'integer', minimum: 1, maximum: maxTimeoutMs },
        },
        required: ['command'],
        additionalProperties: false,
      },
      dangerLevel: 'critical',
      readonly: false,
      requiredPermission: 'full',
      source: 'builtin',
      exposure: 'deferred',
      execution: { concurrency: 'exclusive', timeoutMs: maxTimeoutMs + 5_000 },
      completion: { role: 'deliverable', group: 'process-execution' },
    },
    async (args, context) => {
      const cwd = await workspace.existing(optionalString(args, 'cwd') ?? '.');
      if (!(await stat(cwd)).isDirectory()) throw new Error('Process cwd must be a directory.');
      const snapshot = await options.runtime.exec({
        sessionId: context.session.id,
        command: requireString(args, 'command'),
        cwd,
        background: args.background === true,
        timeoutMs: Math.min(
          optionalPositiveInteger(args, 'timeoutMs', defaultTimeoutMs) ?? defaultTimeoutMs,
          maxTimeoutMs,
        ),
        ...((args.background === true ? context.runSignal : context.signal) === undefined
          ? {}
          : { signal: args.background === true ? context.runSignal : context.signal }),
      });
      return processEnvelope(snapshot);
    },
  );

  registry.register(
    {
      name: 'process_poll',
      title: 'Poll process',
      aliases: [
        'process output',
        'command status',
        'command completion',
        '查看进程',
        '命令输出',
        '命令运行状态',
        '命令是否完成',
      ],
      tags: ['process', 'output', 'status'],
      description:
        'Read new bounded stdout/stderr and status from a process handle owned by the current Session.',
      inputSchema: {
        type: 'object',
        properties: {
          processId: { type: 'string' },
          stdoutOffset: { type: 'integer', minimum: 0 },
          stderrOffset: { type: 'integer', minimum: 0 },
          waitMs: { type: 'integer', minimum: 0, maximum: maxPollWaitMs },
          maxProjectionBytes: { type: 'integer', minimum: 32, maximum: 262144 },
        },
        required: ['processId'],
        additionalProperties: false,
      },
      dangerLevel: 'safe',
      readonly: true,
      source: 'builtin',
      exposure: 'deferred',
      execution: { concurrency: 'read', timeoutMs: maxPollWaitMs + 5_000 },
      completion: { role: 'deliverable', group: 'process-execution' },
    },
    async (args, context) => {
      const snapshot = await options.runtime.poll({
        sessionId: context.session.id,
        processId: requireString(args, 'processId'),
        cursor: cursorFromArguments(args),
        waitMs: Math.min(nonNegativeInteger(args.waitMs, 0), maxPollWaitMs),
        ...(args.maxProjectionBytes === undefined
          ? {}
          : {
              maxProjectionBytes: Math.min(
                optionalPositiveInteger(args, 'maxProjectionBytes', 32_768) ?? 32_768,
                262_144,
              ),
            }),
      });
      return processEnvelope(snapshot);
    },
  );

  registry.register(
    {
      name: 'process_write',
      title: 'Write process input',
      aliases: ['stdin', 'send input', '进程输入'],
      tags: ['process', 'stdin', 'interactive'],
      description: 'Write text to stdin of a running process owned by the current Session.',
      inputSchema: {
        type: 'object',
        properties: {
          processId: { type: 'string' },
          input: { type: 'string' },
          end: { type: 'boolean' },
        },
        required: ['processId', 'input'],
        additionalProperties: false,
      },
      dangerLevel: 'critical',
      readonly: false,
      requiredPermission: 'full',
      source: 'builtin',
      exposure: 'deferred',
      execution: { concurrency: 'exclusive' },
      completion: { role: 'supporting', group: 'process-execution' },
    },
    async (args, context) => {
      const snapshot = await options.runtime.write({
        sessionId: context.session.id,
        processId: requireString(args, 'processId'),
        input: typeof args.input === 'string' ? args.input : '',
        end: args.end === true,
      });
      return processEnvelope(snapshot);
    },
  );

  registry.register(
    {
      name: 'process_terminate',
      title: 'Terminate process',
      aliases: ['stop process', 'kill process', '停止进程'],
      tags: ['process', 'cancel'],
      description: 'Terminate a process and its descendants, then wait for cleanup.',
      inputSchema: {
        type: 'object',
        properties: { processId: { type: 'string' } },
        required: ['processId'],
        additionalProperties: false,
      },
      dangerLevel: 'critical',
      readonly: false,
      requiredPermission: 'full',
      source: 'builtin',
      exposure: 'deferred',
      execution: { concurrency: 'exclusive' },
      completion: { role: 'deliverable', group: 'process-execution' },
    },
    async (args, context) => {
      const snapshot = await options.runtime.terminate({
        sessionId: context.session.id,
        processId: requireString(args, 'processId'),
      });
      return processEnvelope(snapshot);
    },
  );
}

function processEnvelope(snapshot: ProcessRuntimeSnapshot) {
  const completion = processCompletionEvidence(snapshot);
  return createAgentToolResultEnvelope({
    modelProjection: snapshot,
    userProjection: snapshot,
    durableSummary: {
      processId: snapshot.processId,
      status: snapshot.status,
      exitCode: snapshot.exitCode,
      signal: snapshot.signal,
      timedOut: snapshot.timedOut,
      nextCursor: snapshot.nextCursor,
      outputStoredSeparately: true,
      ...(snapshot.error === undefined ? {} : { error: snapshot.error }),
    },
    auditEvidence: {
      status: snapshot.status === 'failed' ? 'failed' : 'success',
      resultType: 'process',
    },
    completionEvidence: completion,
  });
}

function processCompletionEvidence(
  snapshot: ProcessRuntimeSnapshot,
): AgentToolCompletionEvidence {
  const outcome =
    snapshot.status === 'running'
      ? 'pending'
      : snapshot.status === 'terminated'
        ? 'cancelled'
        : snapshot.status === 'exited' && snapshot.exitCode === 0
          ? 'succeeded'
          : 'failed';
  return {
    kind: 'process',
    deliveryReady: outcome !== 'pending',
    source: 'runtime',
    executionId: snapshot.processId,
    outcome,
  };
}

function cursorFromArguments(args: Record<string, unknown>): ProcessOutputCursor {
  return {
    stdoutBytes: nonNegativeInteger(args.stdoutOffset, 0),
    stderrBytes: nonNegativeInteger(args.stderrOffset, 0),
  };
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  return typeof value !== 'number' || !Number.isFinite(value) || value < 0
    ? fallback
    : Math.floor(value);
}
