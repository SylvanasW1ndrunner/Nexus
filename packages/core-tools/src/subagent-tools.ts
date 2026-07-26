import type {
  AgentRunOptions,
  AgentSubagentRecord,
  AgentSubagentPool,
  AgentToolContext,
  ToolRegistry,
} from '@dbagent/core-agent';
import { optionalPositiveInteger, requireString } from './validation.js';

export type SubagentToolOptions = {
  pool: AgentSubagentPool;
  buildRunOptions: (
    task: string,
    context: AgentToolContext,
  ) => AgentRunOptions | Promise<AgentRunOptions>;
};

export function registerSubagentTools(registry: ToolRegistry, options: SubagentToolOptions): void {
  registry.register(
    {
      name: 'subagent_spawn',
      description:
        'Start an independent-context Agent for one bounded parallel subtask. The child has the same generic capabilities but only the delegated goal.',
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string' },
        },
        required: ['task'],
        additionalProperties: false,
      },
      dangerLevel: 'safe',
      readonly: true,
      source: 'builtin',
    },
    async (args, context) => {
      const task = requireString(args, 'task');
      const runOptions = await options.buildRunOptions(task, context);
      const childOptions = { ...runOptions };
      delete childOptions.initialSession;
      delete childOptions.project;
      const record = await options.pool.spawn({
        parentSessionId: context.session.id,
        task,
        depth: (context.session.subagentDepth ?? 0) + 1,
        options: {
          ...childOptions,
          userMessage: task,
          subagentDepth: (context.session.subagentDepth ?? 0) + 1,
          ...(context.session.project === undefined ? {} : { project: context.session.project }),
        },
      });
      return projectRecord(record);
    },
  );

  registry.register(
    {
      name: 'subagent_list',
      description: 'List child tasks for the current session and their current status.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      dangerLevel: 'safe',
      readonly: true,
      source: 'builtin',
    },
    (_args, context) => ({
      subagents: options.pool.list(context.session.id).map(projectRecord),
    }),
  );

  registry.register(
    {
      name: 'subagent_wait',
      description: 'Wait briefly for one child task and return its summary or current status.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          timeoutMs: { type: 'integer', minimum: 1, maximum: 60000 },
        },
        required: ['id'],
        additionalProperties: false,
      },
      dangerLevel: 'safe',
      readonly: true,
      source: 'builtin',
    },
    async (args, context) => {
      const id = requireString(args, 'id');
      assertOwnedSubagent(options.pool, id, context.session.id);
      return projectRecord(
        await options.pool.wait(
          id,
          Math.min(optionalPositiveInteger(args, 'timeoutMs', 30_000) ?? 30_000, 60_000),
        ),
      );
    },
  );

  registry.register(
    {
      name: 'subagent_stop',
      description: 'Cancel one running child task.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      dangerLevel: 'medium',
      readonly: false,
      requiredPermission: 'edit',
      source: 'builtin',
    },
    (args, context) => {
      const id = requireString(args, 'id');
      assertOwnedSubagent(options.pool, id, context.session.id);
      return {
        stopped: options.pool.stop(id),
      };
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
    status: record.status,
    ...(record.summary === undefined ? {} : { summary: record.summary }),
    ...(record.artifactReferences === undefined ? {} : { artifacts: record.artifactReferences }),
    ...(record.errorMessage === undefined ? {} : { error: record.errorMessage }),
  };
}
