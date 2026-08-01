import {
  createAgentTaskPlan,
  LexicalToolSearchIndex,
  updateAgentTask,
  type AgentSession,
  type AgentTaskStatus,
  type AgentToolContext,
  type ToolRegistry,
} from '@dbagent/core-agent';
import { optionalPositiveInteger, optionalString, requireString } from './validation.js';

const DISCOVERY_TOOL_NAMES = new Set([
  'task_plan_create',
  'task_update',
  'task_list',
  'tool_search',
  'tool_describe',
]);

export function registerAgentRuntimeTools(registry: ToolRegistry): void {
  let indexedRevision = -1;
  let searchIndex: LexicalToolSearchIndex | undefined;
  const currentSearchIndex = () => {
    if (!searchIndex || indexedRevision !== registry.catalogRevision) {
      searchIndex = new LexicalToolSearchIndex(
        registry
          .listDescriptors()
          .filter((tool) => tool.exposure !== 'hidden' && tool.exposure !== 'disabled'),
      );
      indexedRevision = registry.catalogRevision;
    }
    return searchIndex;
  };

  registry.register(
    {
      name: 'task_plan_create',
      description:
        'Create or replace a lightweight working plan for multi-step work. Use it only when a visible plan helps execution.',
      inputSchema: {
        type: 'object',
        properties: {
          goal: { type: 'string' },
          tasks: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                description: { type: 'string' },
              },
              required: ['title'],
              additionalProperties: false,
            },
          },
        },
        required: ['goal', 'tasks'],
        additionalProperties: false,
      },
      dangerLevel: 'safe',
      readonly: true,
      source: 'builtin',
      exposure: 'direct',
      execution: { concurrency: 'write' },
    },
    (args, context) => {
      const tasks = requireObjectArray(args, 'tasks').map((task) => {
        const id = optionalObjectString(task, 'id');
        const description = optionalObjectString(task, 'description');
        return {
          ...(id === undefined ? {} : { id }),
          title: requireObjectString(task, 'title'),
          ...(description === undefined ? {} : { description }),
        };
      });
      context.session.taskPlan = createAgentTaskPlan({
        goal: requireString(args, 'goal'),
        tasks,
      });
      return projectTaskPlan(context.session.taskPlan);
    },
  );

  registry.register(
    {
      name: 'task_update',
      description:
        'Update one item in the working plan. Runtime tool records, not this plan, determine whether the result is complete.',
      inputSchema: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          status: {
            type: 'string',
            enum: ['pending', 'in_progress', 'completed', 'cancelled'],
          },
          title: { type: 'string' },
          description: { type: 'string' },
        },
        required: ['taskId'],
        additionalProperties: false,
      },
      dangerLevel: 'safe',
      readonly: true,
      source: 'builtin',
      exposure: 'direct',
      execution: { concurrency: 'write' },
    },
    (args, context) => {
      if (!context.session.taskPlan) {
        throw new Error('No active task plan. Create one first.');
      }
      const status = optionalString(args, 'status');
      assertTaskStatus(status);
      const description = optionalString(args, 'description');
      context.session.taskPlan = updateAgentTask(context.session.taskPlan, {
        taskId: requireString(args, 'taskId'),
        ...(status === undefined ? {} : { status }),
        ...(args.title === undefined ? {} : { title: requireString(args, 'title') }),
        ...(description === undefined ? {} : { description }),
      });
      return projectTaskPlan(context.session.taskPlan);
    },
  );

  registry.register(
    {
      name: 'task_list',
      description: 'Read the current lightweight task goal and progress.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      dangerLevel: 'safe',
      readonly: true,
      source: 'builtin',
      exposure: 'direct',
      execution: { concurrency: 'read' },
    },
    (_args, context) =>
      context.session.taskPlan ? projectTaskPlan(context.session.taskPlan) : { active: false },
  );

  registry.register(
    {
      name: 'tool_search',
      description:
        'Discover available tools by capability. Matching tools become available in later Agent turns when dynamic discovery is enabled.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 20 },
        },
        required: ['query'],
        additionalProperties: false,
      },
      dangerLevel: 'safe',
      readonly: true,
      source: 'builtin',
      exposure: 'direct',
      execution: { concurrency: 'write' },
    },
    (args, context) => {
      const query = requireString(args, 'query');
      const limit = Math.min(optionalPositiveInteger(args, 'limit', 8) ?? 8, 20);
      const matches = currentSearchIndex()
        .search(query, {
          limit: Math.min(limit + DISCOVERY_TOOL_NAMES.size, 100),
          ...(context.allowedTools === undefined
            ? {}
            : { allowedTools: context.allowedTools }),
        })
        .filter((item) => !DISCOVERY_TOOL_NAMES.has(item.tool.flatName))
        .slice(0, limit);
      const active = new Set(context.session.activeTools ?? []);
      for (const { tool } of matches) active.add(tool.flatName);
      context.session.activeTools = [...active].sort();
      activateTools(
        context.session,
        matches.map((match) => match.tool.flatName),
        context.toolActivationScope ?? {
          catalogRevision: registry.catalogRevision,
          ...(context.session.contextCheckpoint?.sequence === undefined
            ? {}
            : { checkpointSequence: context.session.contextCheckpoint.sequence }),
          taskPhase: 'act',
          activatedAt: new Date().toISOString(),
        },
      );
      return {
        tools: matches.map(({ tool }) => ({
          name: tool.flatName,
          description: tool.description,
          inputSchema: tool.inputSchema,
          readonly: tool.readonly === true,
          ...(tool.requiredPermission === undefined
            ? {}
            : { requiredPermission: tool.requiredPermission }),
        })),
      };
    },
  );

  registry.register(
    {
      name: 'tool_describe',
      description: 'Read the exact input schema and permission level for one discovered tool.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
        additionalProperties: false,
      },
      dangerLevel: 'safe',
      readonly: true,
      source: 'builtin',
      exposure: 'direct',
      execution: { concurrency: 'write' },
    },
    (args, context) => {
      const name = requireString(args, 'name');
      const tool = registry.get(name);
      const allowed =
        context.allowedTools === undefined ? undefined : new Set(context.allowedTools);
      if (
        !tool ||
        tool.descriptor.exposure === 'hidden' ||
        tool.descriptor.exposure === 'disabled' ||
        (allowed !== undefined && !allowed.has(name))
      ) {
        throw new Error(`Tool is unavailable for this run: ${name}.`);
      }
      const active = new Set(context.session.activeTools ?? []);
      active.add(name);
      context.session.activeTools = [...active].sort();
      activateTools(
        context.session,
        [name],
        context.toolActivationScope ?? {
          catalogRevision: registry.catalogRevision,
          ...(context.session.contextCheckpoint?.sequence === undefined
            ? {}
            : { checkpointSequence: context.session.contextCheckpoint.sequence }),
          taskPhase: 'act',
          activatedAt: new Date().toISOString(),
        },
      );
      return {
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        readonly: tool.readonly === true,
        ...(tool.requiredPermission === undefined
          ? {}
          : { requiredPermission: tool.requiredPermission }),
      };
    },
  );
}

function activateTools(
  session: AgentSession,
  toolNames: readonly string[],
  scope: NonNullable<AgentToolContext['toolActivationScope']>,
): void {
  const activatedNames = new Set(toolNames);
  const retained = (session.toolActivations ?? []).filter(
    (activation) => !activatedNames.has(activation.toolName),
  );
  session.toolActivations = [
    ...retained,
    ...toolNames.map((toolName) => ({
      toolName,
      catalogRevision: scope.catalogRevision,
      ...(scope.checkpointSequence === undefined
        ? {}
        : { checkpointSequence: scope.checkpointSequence }),
      ...(scope.taskPhase === undefined ? {} : { taskPhase: scope.taskPhase }),
      activatedAt: scope.activatedAt,
    })),
  ].sort((left, right) => left.toolName.localeCompare(right.toolName));
}

function projectTaskPlan(plan: NonNullable<Parameters<typeof updateAgentTask>[0]>) {
  return {
    goal: plan.goal,
    tasks: plan.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      ...(task.description === undefined ? {} : { description: task.description }),
      status: task.status,
    })),
  };
}

function assertTaskStatus(value: string | undefined): asserts value is AgentTaskStatus | undefined {
  if (
    value !== undefined &&
    !['pending', 'in_progress', 'completed', 'cancelled'].includes(value)
  ) {
    throw new Error(`Unsupported task status: ${value}.`);
  }
}

function requireObjectArray(
  args: Record<string, unknown>,
  key: string,
): Array<Record<string, unknown>> {
  const value = args[key];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => !item || typeof item !== 'object' || Array.isArray(item))
  ) {
    throw new Error(`Tool argument "${key}" must be a non-empty object array.`);
  }
  return value as Array<Record<string, unknown>>;
}

function requireObjectString(value: Record<string, unknown>, key: string): string {
  const item = value[key];
  if (typeof item !== 'string' || !item.trim()) {
    throw new Error(`Object field "${key}" must be a non-empty string.`);
  }
  return item.trim();
}

function optionalObjectString(value: Record<string, unknown>, key: string): string | undefined {
  const item = value[key];
  if (item === undefined) return undefined;
  if (typeof item !== 'string') {
    throw new Error(`Object field "${key}" must be a string.`);
  }
  return item.trim() || undefined;
}
