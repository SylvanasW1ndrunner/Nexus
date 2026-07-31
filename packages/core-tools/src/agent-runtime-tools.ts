import {
  createAgentTaskPlan,
  updateAgentTask,
  type AgentTaskStatus,
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
    },
    (args, context) => {
      const terms = tokenize(requireString(args, 'query'));
      const limit = Math.min(optionalPositiveInteger(args, 'limit', 8) ?? 8, 20);
      const allowed =
        context.allowedTools === undefined ? undefined : new Set(context.allowedTools);
      const matches = registry
        .list()
        .filter(
          (tool) =>
            !DISCOVERY_TOOL_NAMES.has(tool.name) &&
            (allowed === undefined || allowed.has(tool.name)),
        )
        .map((tool) => ({
          tool,
          score: scoreTool(terms, `${tool.name} ${tool.description}`),
        }))
        .filter((item) => item.score > 0)
        .sort(
          (left, right) =>
            right.score - left.score || left.tool.name.localeCompare(right.tool.name),
        )
        .slice(0, limit);
      const active = new Set(context.session.activeTools ?? []);
      for (const { tool } of matches) active.add(tool.name);
      context.session.activeTools = [...active].sort();
      return {
        tools: matches.map(({ tool }) => ({
          name: tool.name,
          description: tool.description,
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
    },
    (args, context) => {
      const name = requireString(args, 'name');
      const tool = registry.get(name);
      const allowed =
        context.allowedTools === undefined ? undefined : new Set(context.allowedTools);
      if (!tool || (allowed !== undefined && !allowed.has(name))) {
        throw new Error(`Tool is unavailable for this run: ${name}.`);
      }
      const active = new Set(context.session.activeTools ?? []);
      active.add(name);
      context.session.activeTools = [...active].sort();
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

function tokenize(value: string): string[] {
  return [...new Set(value.toLocaleLowerCase().split(/[^\p{L}\p{N}_]+/u))].filter(Boolean);
}

function scoreTool(terms: string[], value: string): number {
  const normalized = value.toLocaleLowerCase();
  return terms.reduce((score, term) => score + (normalized.includes(term) ? 1 : 0), 0);
}
