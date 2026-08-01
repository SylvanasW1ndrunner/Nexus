import { randomUUID } from 'node:crypto';
import {
  createAgentSession,
  createAgentToolResultEnvelope,
  forkAgentSessionForSubagent,
  type AgentRunOptions,
  type AgentSubagentContextStrategy,
  type AgentSubagentRecord,
  type AgentSubagentPool,
  type AgentToolContext,
  type ToolRegistry,
} from '@dbagent/core-agent';
import { optionalPositiveInteger, requireString } from './validation.js';

export type SubagentToolOptions = {
  pool: AgentSubagentPool;
  buildRunOptions: (
    task: string,
    context: AgentToolContext,
    strategy: AgentSubagentContextStrategy,
  ) => AgentRunOptions | Promise<AgentRunOptions>;
  createChildSessionId?: () => string;
  now?: () => string;
};

export function registerSubagentTools(registry: ToolRegistry, options: SubagentToolOptions): void {
  const now = options.now ?? (() => new Date().toISOString());
  const createChildSessionId = options.createChildSessionId ?? randomUUID;

  registry.register(
    {
      name: 'subagent_spawn',
      description:
        'Start an independent child Agent for one bounded subtask. Use fresh for isolated work or fork to inherit the parent working context without sharing mutable state.',
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string' },
          contextStrategy: { type: 'string', enum: ['fresh', 'fork'] },
        },
        required: ['task'],
        additionalProperties: false,
      },
      dangerLevel: 'safe',
      readonly: true,
      requiredPermission: 'read',
      source: 'builtin',
      exposure: 'deferred',
      execution: { concurrency: 'write' },
      completion: { role: 'supporting', group: 'subagent' },
    },
    async (args, context) => {
      const task = requireString(args, 'task');
      const strategy = contextStrategy(args.contextStrategy);
      const depth = (context.session.subagentDepth ?? 0) + 1;
      const runOptions = await options.buildRunOptions(task, context, strategy);
      const childSessionId = createChildSessionId();
      const initialSession =
        strategy === 'fork'
          ? forkAgentSessionForSubagent({
              parent: context.session,
              id: childSessionId,
              title: task,
              depth,
              now,
            })
          : createAgentSession({
              id: childSessionId,
              title: task,
              mode: runOptions.mode ?? context.session.mode,
              ...(runOptions.userId ?? context.session.userId) === undefined
                ? {}
                : { userId: runOptions.userId ?? context.session.userId },
              ...(runOptions.knowledgeSnapshot ?? context.session.knowledgeSnapshot) === undefined
                ? {}
                : {
                    knowledgeSnapshot: structuredClone(
                      runOptions.knowledgeSnapshot ?? context.session.knowledgeSnapshot!,
                    ),
                  },
              ...(runOptions.project ?? context.session.project) === undefined
                ? {}
                : { project: structuredClone(runOptions.project ?? context.session.project!) },
              ...(runOptions.sessionSkills ?? context.session.sessionSkills) === undefined
                ? {}
                : {
                    sessionSkills: structuredClone(
                      runOptions.sessionSkills ?? context.session.sessionSkills!,
                    ),
                  },
              subagentDepth: depth,
              now,
            });
      const childOptions: AgentRunOptions = {
        ...runOptions,
        initialSession,
        userMessage: task,
        subagentDepth: depth,
        ...(initialSession.project === undefined ? {} : { project: initialSession.project }),
        ...(context.runSignal ?? context.signal) === undefined
          ? {}
          : { signal: context.runSignal ?? context.signal },
      };
      const record = await options.pool.spawn({
        parentSessionId: context.session.id,
        task,
        depth,
        contextStrategy: strategy,
        options: childOptions,
      });
      return projectRecord(record);
    },
  );

  registry.register(
    {
      name: 'subagent_list',
      description: 'List child tasks for the current Session and their current status.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      dangerLevel: 'safe',
      readonly: true,
      source: 'builtin',
      exposure: 'deferred',
      execution: { concurrency: 'read' },
      completion: { role: 'supporting', group: 'subagent' },
    },
    (_args, context) => ({
      subagents: options.pool.list(context.session.id).map(projectRecord),
    }),
  );

  registry.register(
    {
      name: 'subagent_wait',
      description: 'Wait briefly for one child task and return only its status, summary and artifacts.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          timeoutMs: { type: 'integer', minimum: 1, maximum: 60_000 },
        },
        required: ['id'],
        additionalProperties: false,
      },
      dangerLevel: 'safe',
      readonly: true,
      source: 'builtin',
      exposure: 'deferred',
      execution: { concurrency: 'read', timeoutMs: 65_000 },
      completion: { role: 'deliverable', group: 'subagent' },
    },
    async (args, context) => {
      const id = requireString(args, 'id');
      assertOwnedSubagent(options.pool, id, context.session.id);
      const record = await options.pool.wait(
        id,
        Math.min(optionalPositiveInteger(args, 'timeoutMs', 30_000) ?? 30_000, 60_000),
      );
      return subagentEnvelope(record);
    },
  );

  registry.register(
    {
      name: 'subagent_message',
      description: 'Send a supplemental user instruction to one running child Agent.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, message: { type: 'string' } },
        required: ['id', 'message'],
        additionalProperties: false,
      },
      dangerLevel: 'safe',
      readonly: true,
      requiredPermission: 'read',
      source: 'builtin',
      exposure: 'deferred',
      execution: { concurrency: 'write' },
      completion: { role: 'supporting', group: 'subagent' },
    },
    (args, context) => {
      const id = requireString(args, 'id');
      assertOwnedSubagent(options.pool, id, context.session.id);
      const sent = options.pool.message(id, requireString(args, 'message'));
      if (!sent) throw new Error('Subagent is not running or cannot accept messages.');
      return { id, sent: true };
    },
  );

  registry.register(
    {
      name: 'subagent_stop',
      description: 'Cancel one running child task and wait for its runner to stop separately.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      dangerLevel: 'safe',
      readonly: true,
      requiredPermission: 'read',
      source: 'builtin',
      exposure: 'deferred',
      execution: { concurrency: 'write' },
      completion: { role: 'deliverable', group: 'subagent' },
    },
    (args, context) => {
      const id = requireString(args, 'id');
      assertOwnedSubagent(options.pool, id, context.session.id);
      const stopped = options.pool.stop(id);
      return createAgentToolResultEnvelope({
        modelProjection: { id, stopped },
        userProjection: { id, stopped },
        durableSummary: { id, stopped },
        completionEvidence: {
          kind: 'subagent',
          deliveryReady: true,
          source: 'runtime',
          executionId: id,
          outcome: stopped ? 'cancelled' : 'failed',
        },
      });
    },
  );
}

function assertOwnedSubagent(pool: AgentSubagentPool, id: string, parentSessionId: string): void {
  const record = pool.get(id);
  if (!record || record.parentSessionId !== parentSessionId) {
    throw new Error('Subagent not found for the current Session.');
  }
}

function projectRecord(record: AgentSubagentRecord) {
  return {
    id: record.id,
    task: record.task,
    contextStrategy: record.contextStrategy,
    status: record.status,
    ...(record.summary === undefined ? {} : { summary: record.summary }),
    ...(record.artifactReferences === undefined ? {} : { artifacts: record.artifactReferences }),
    ...(record.errorMessage === undefined ? {} : { error: record.errorMessage }),
  };
}

function subagentEnvelope(record: AgentSubagentRecord) {
  const projection = projectRecord(record);
  const outcome =
    record.status === 'running'
      ? 'pending'
      : record.status === 'completed'
        ? 'succeeded'
        : record.status === 'cancelled'
          ? 'cancelled'
          : 'failed';
  return createAgentToolResultEnvelope({
    modelProjection: projection,
    userProjection: projection,
    durableSummary: projection,
    completionEvidence: {
      kind: 'subagent',
      deliveryReady: outcome !== 'pending',
      source: 'runtime',
      executionId: record.id,
      outcome,
    },
  });
}

function contextStrategy(value: unknown): AgentSubagentContextStrategy {
  if (value === undefined || value === 'fresh') return 'fresh';
  if (value === 'fork') return 'fork';
  const rendered = typeof value === 'string' ? value : (JSON.stringify(value) ?? typeof value);
  throw new Error(`Unsupported subagent context strategy: ${rendered}.`);
}
