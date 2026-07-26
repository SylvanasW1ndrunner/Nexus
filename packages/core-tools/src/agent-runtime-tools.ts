import {
  createAgentTaskPlan,
  updateAgentTask,
  type AgentTaskEvidence,
  type AgentTaskStatus,
  type AgentSession,
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
        'Create or replace the working task plan for multi-step work. Each item must state how completion will be verified.',
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
                acceptanceCriteria: {
                  type: 'array',
                  items: { type: 'string' },
                },
                dependsOn: {
                  type: 'array',
                  items: { type: 'string' },
                },
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
          acceptanceCriteria: optionalStringArray(task, 'acceptanceCriteria'),
          dependsOn: optionalStringArray(task, 'dependsOn'),
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
        'Update one task status or attach concise verification evidence. Complete tasks only after their acceptance criteria are satisfied.',
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
          acceptanceCriteria: {
            type: 'array',
            items: { type: 'string' },
          },
          evidence: {
            type: 'object',
            properties: {
              kind: {
                type: 'string',
                enum: [
                  'tool-result',
                  'database-result',
                  'artifact',
                  'user-confirmation',
                  'observation',
                ],
              },
              summary: { type: 'string' },
              reference: { type: 'string' },
            },
            required: ['kind', 'summary'],
            additionalProperties: false,
          },
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
      const evidence = optionalEvidence(args.evidence);
      if (evidence !== undefined) {
        assertEvidenceBackedBySession(evidence, context.session);
      }
      const description = optionalString(args, 'description');
      context.session.taskPlan = updateAgentTask(context.session.taskPlan, {
        taskId: requireString(args, 'taskId'),
        ...(status === undefined ? {} : { status }),
        ...(args.title === undefined ? {} : { title: requireString(args, 'title') }),
        ...(description === undefined ? {} : { description }),
        ...(args.acceptanceCriteria === undefined
          ? {}
          : {
              acceptanceCriteria: requireStringArray(args, 'acceptanceCriteria'),
            }),
        ...(evidence === undefined ? {} : { evidence }),
      });
      return projectTaskPlan(context.session.taskPlan);
    },
  );

  registry.register(
    {
      name: 'task_list',
      description:
        'Read the current task goal, progress, completion criteria, and verification evidence.',
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
      acceptanceCriteria: task.acceptanceCriteria,
      dependsOn: task.dependsOn,
      evidence: task.evidence.map((item) => ({
        kind: item.kind,
        summary: item.summary,
        ...(item.reference === undefined ? {} : { reference: item.reference }),
      })),
    })),
  };
}

function optionalEvidence(value: unknown): Omit<AgentTaskEvidence, 'createdAt'> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Tool argument "evidence" must be an object.');
  }
  const record = value as Record<string, unknown>;
  const kind = requireObjectString(record, 'kind');
  if (
    !['tool-result', 'database-result', 'artifact', 'user-confirmation', 'observation'].includes(
      kind,
    )
  ) {
    throw new Error(`Unsupported evidence kind: ${kind}.`);
  }
  const reference = optionalObjectString(record, 'reference');
  return {
    kind: kind as AgentTaskEvidence['kind'],
    summary: requireObjectString(record, 'summary'),
    ...(reference === undefined ? {} : { reference }),
  };
}

function assertEvidenceBackedBySession(
  evidence: Omit<AgentTaskEvidence, 'createdAt'>,
  session: AgentSession,
): void {
  if (evidence.kind === 'observation') return;
  const reference = evidence.reference?.trim();
  if (!reference) {
    throw new Error(`${evidence.kind} evidence requires a reference to existing Session evidence.`);
  }
  const candidates = [
    reference,
    ...reference
      .split(/[\s=:;,]+/)
      .map((value) => value.trim())
      .filter((value) => value.length >= 8),
  ];
  if (evidence.kind === 'artifact') {
    if (
      session.artifacts?.some((artifact) =>
        candidates.some(
          (candidate) => artifact.id.includes(candidate) || artifact.path.includes(candidate),
        ),
      )
    ) {
      return;
    }
    throw new Error('Artifact evidence reference does not exist in the current Session.');
  }
  if (evidence.kind === 'user-confirmation') {
    if (
      session.messages.some(
        (message) =>
          message.role === 'user' &&
          candidates.some((candidate) => message.content.includes(candidate)),
      )
    ) {
      return;
    }
    throw new Error('User-confirmation evidence is not present in the current Session.');
  }
  if (
    session.messages.some(
      (message) =>
        message.role === 'tool' &&
        candidates.some(
          (candidate) =>
            message.toolCallId.includes(candidate) || message.content.includes(candidate),
        ),
    )
  ) {
    return;
  }
  throw new Error(`${evidence.kind} evidence reference is not present in prior tool results.`);
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

function optionalStringArray(value: Record<string, unknown>, key: string): string[] {
  const item = value[key];
  if (item === undefined) return [];
  return requireStringArray(value, key);
}

function requireStringArray(value: Record<string, unknown>, key: string): string[] {
  const item = value[key];
  if (!Array.isArray(item) || item.some((entry) => typeof entry !== 'string' || !entry.trim())) {
    throw new Error(`Object field "${key}" must be a string array.`);
  }
  return item.map((entry) => String(entry).trim());
}

function tokenize(value: string): string[] {
  return [...new Set(value.toLocaleLowerCase().split(/[^\p{L}\p{N}_]+/u))].filter(Boolean);
}

function scoreTool(terms: string[], value: string): number {
  const normalized = value.toLocaleLowerCase();
  return terms.reduce((score, term) => score + (normalized.includes(term) ? 1 : 0), 0);
}
