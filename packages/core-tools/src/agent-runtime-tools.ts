import {
  PREPARED_TOOL_INTENT_REVISION,
  createAgentTaskPlan,
  createRuntimeCommandToolResult,
  expectedToolError,
  ToolExecutionError,
  updateAgentTask,
  type AgentTaskPlan,
  type AgentTaskStatus,
  type InvocationLimits,
  type RuntimeCommandProjection,
  type ToolInvocationContribution,
  type ToolInvocationExecutionContext,
  type ToolTargetRevalidator,
  type ToolRegistry,
} from '@dbagent/core-agent';
import type { PortableValue } from '@dbagent/shared';

const TASK_TOOL_LIMITS = Object.freeze({
  timeoutMs: 15_000,
  maxInputBytes: 96 * 1024,
  maxOutputBytes: 96 * 1024,
  maxArtifactBytes: 96 * 1024,
  maxDepth: 8,
  // A prepared write contains both the full durable plan command and its
  // bounded model projection.  100 fully populated items need well beyond
  // the public schema's 100 array elements.
  maxRecords: 4_096,
});
const MAX_TASKS = 100;
const MAX_PLAN_BYTES = 64 * 1024;
const MAX_GOAL_CHARS = 4_096;
const MAX_TASK_ID_CHARS = 128;
const MAX_TASK_TITLE_CHARS = 256;
const MAX_TASK_DESCRIPTION_CHARS = 1_024;

export function registerAgentRuntimeTools(
  registry: ToolRegistry,
): void {
  for (const contribution of createTaskToolContributions()) {
    registry.registerInvocation(contribution.definition, contribution.runtime);
  }
}

/** Deferred coordination helpers; task records remain advisory, not completion evidence. */
export function createTaskToolContributions(): readonly ToolInvocationContribution[] {
  return Object.freeze([
    taskPlanCreateContribution(),
    taskUpdateContribution(),
    taskListContribution(),
  ]);
}

/**
 * Runtime-owned plan targets are revalidated against the current Journal
 * projection before a frozen write command can execute. Hosts compose this
 * with workspace/process/web target revalidators at Kernel construction.
 */
export function createTaskPlanTargetRevalidator(): ToolTargetRevalidator {
  return (intent, context) => {
    if (!['task_plan_create', 'task_update', 'task_list'].includes(intent.permission.toolName)) {
      return;
    }
    const target = taskPlanTargetIdentity(intent.targetIdentity);
    if (target === undefined) return 'target_changed';
    if (target.runId !== context.runId) return 'conflict';
    const current = requireRuntimeState(context).plan;
    if (target.state === 'absent') return current === null ? undefined : 'conflict';
    if (
      current === null || current.planId !== target.planId || current.revision !== target.revision
    ) {
      return 'conflict';
    }
    if (target.taskId === undefined) return;
    const task = (current.plan as AgentTaskPlan).tasks.find((candidate) => candidate.id === target.taskId);
    return task === undefined || task.status !== target.taskStatus || task.updatedAt !== target.taskUpdatedAt
      ? 'conflict'
      : undefined;
  };
}

function taskPlanCreateContribution(): ToolInvocationContribution {
  return taskContribution({
    name: 'task_plan_create',
    description: 'Create or replace a bounded working plan for multi-step work.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['goal', 'tasks'],
      properties: {
        goal: { type: 'string', minLength: 1, maxLength: MAX_GOAL_CHARS },
        tasks: {
          type: 'array', minItems: 1, maxItems: MAX_TASKS,
          items: taskInputSchema(false),
        },
      },
    },
    access: 'write',
    concurrency: 'write',
    recoveryClass: 'idempotent',
    prepare(input, context) {
      const goal = boundedRequiredText(input.goal, 'goal', MAX_GOAL_CHARS);
      const tasks = boundedTaskInputs(input.tasks, false);
      const current = requireRuntimeState(context).plan;
      let generatedId = 0;
      const plan = createBoundedPlan({
        goal,
        tasks,
        now: new Date().toISOString(),
        createId: () => `${context.invocationId}-${++generatedId}`,
      });
      const command = current === null
        ? { kind: 'plan.create' as const, payload: { planId: `plan:${context.runId}`, plan } }
        : {
            kind: 'plan.update' as const,
            payload: { planId: current.planId, expectedPlanRevision: current.revision, plan },
          };
      const targetIdentity = current === null
        ? { kind: 'runtime-task-plan', state: 'absent', runId: context.runId }
        : {
            kind: 'runtime-task-plan', state: 'present', runId: context.runId,
            planId: current.planId, revision: current.revision,
          };
      assertTaskCommandBytes(command, plan);
      return preparedTaskIntent({
        input: { command, targetIdentity }, targetIdentity,
        context, access: 'write', concurrency: 'write',
        recoveryClass: 'idempotent', action: `Create a ${tasks.length}-item task plan.`,
      });
    },
    execute(input) {
      const { command, result } = preparedTaskCommand(input);
      return createRuntimeCommandToolResult({
        command,
        result,
      });
    },
  });
}

function taskUpdateContribution(): ToolInvocationContribution {
  return taskContribution({
    name: 'task_update',
    description: 'Update one bounded task-plan item. Runtime tool records determine completion independently.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['taskId'],
      properties: {
        taskId: { type: 'string', minLength: 1, maxLength: MAX_TASK_ID_CHARS },
        status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'] },
        title: { type: 'string', minLength: 1, maxLength: MAX_TASK_TITLE_CHARS },
        description: { type: 'string', maxLength: MAX_TASK_DESCRIPTION_CHARS },
      },
    },
    access: 'write',
    concurrency: 'write',
    recoveryClass: 'idempotent',
    prepare(input, context) {
      const taskId = boundedRequiredText(input.taskId, 'taskId', MAX_TASK_ID_CHARS);
      const status = optionalTaskStatus(input.status);
      const title = optionalBoundedText(input.title, 'title', MAX_TASK_TITLE_CHARS);
      const description = optionalBoundedText(input.description, 'description', MAX_TASK_DESCRIPTION_CHARS);
      if (status === undefined && title === undefined && description === undefined) {
        throw expectedToolError('invalid_argument', 'task_update requires status, title, or description.');
      }
      const current = requireRuntimeState(context).plan;
      if (current === null) throw expectedToolError('precondition', 'Create a task plan before updating a task.');
      const currentPlan = current.plan as AgentTaskPlan;
      const task = currentPlan.tasks.find((candidate) => candidate.id === taskId);
      if (task === undefined) throw expectedToolError('not_found', 'The requested task is not in the current task plan.');
      let plan: AgentTaskPlan;
      try {
        plan = updateAgentTask(currentPlan, {
          taskId,
          ...(status === undefined ? {} : { status }),
          ...(title === undefined ? {} : { title }),
          ...(description === undefined ? {} : { description }),
          now: new Date().toISOString(),
        });
      } catch (error) {
        throw expectedToolError('conflict', taskPlanErrorSummary(error));
      }
      const command = {
        kind: 'plan.update' as const,
        payload: { planId: current.planId, expectedPlanRevision: current.revision, plan },
      };
      const targetIdentity = {
        kind: 'runtime-task-plan', state: 'present', runId: context.runId,
        planId: current.planId, revision: current.revision, taskId,
        taskStatus: task.status, taskUpdatedAt: task.updatedAt,
      };
      assertTaskCommandBytes(command, plan);
      return preparedTaskIntent({
        input: { command, targetIdentity }, targetIdentity,
        context, access: 'write', concurrency: 'write',
        recoveryClass: 'idempotent', action: `Update task ${taskId}.`,
      });
    },
    execute(input) {
      const { command, result } = preparedTaskCommand(input);
      return createRuntimeCommandToolResult({
        command,
        result,
      });
    },
  });
}

function taskListContribution(): ToolInvocationContribution {
  return taskContribution({
    name: 'task_list',
    description: 'Read the current bounded working plan and task progress.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    access: 'read',
    concurrency: 'read',
    recoveryClass: 'read',
    prepare(_input, context) {
      const current = requireRuntimeState(context).plan;
      const targetIdentity = current === null
        ? { kind: 'runtime-task-plan', state: 'absent', runId: context.runId }
        : {
            kind: 'runtime-task-plan', state: 'present', runId: context.runId,
            planId: current.planId, revision: current.revision,
          };
      return preparedTaskIntent({
        input: {}, targetIdentity, context, access: 'read', concurrency: 'read', recoveryClass: 'read',
        action: 'Read the current task plan.',
      });
    },
    execute(_input, context) {
      const current = requireRuntimeState(context).plan;
      return current === null
        ? { status: 'ok', summary: 'No task plan is active.', active: false }
        : taskPlanResult('Current task plan read.', assertBoundedDurablePlan(current.plan as AgentTaskPlan));
    },
  });
}

function taskContribution(input: Readonly<{
  name: 'task_plan_create' | 'task_update' | 'task_list';
  description: string;
  inputSchema: Record<string, PortableValue>;
  access: 'read' | 'write';
  concurrency: 'read' | 'write';
  recoveryClass: 'read' | 'idempotent';
  prepare: ToolInvocationContribution['runtime']['prepare'];
  execute: ToolInvocationContribution['runtime']['execute'];
}>): ToolInvocationContribution {
  const toolRevision = `${input.name}.v1`;
  const handlerRevision = `${input.name}.handler.v1`;
  return Object.freeze({
    definition: {
      name: input.name,
      description: input.description,
      aliases: [], tags: ['coordination', 'task-plan'], source: 'runtime', exposure: 'deferred',
      dangerLevel: 'safe', readonly: input.access === 'read', access: input.access,
      recoveryClass: input.recoveryClass, permission: { actions: [input.access] },
      inputSchema: input.inputSchema,
      outputSchema: taskOutputSchema(),
      limits: TASK_TOOL_LIMITS,
      toolRevision, handlerRevision, intentRevision: PREPARED_TOOL_INTENT_REVISION,
      execution: { concurrency: input.concurrency, timeoutMs: TASK_TOOL_LIMITS.timeoutMs },
      failurePolicy: { onUnknown: { failureKind: 'unknown', retryable: false } },
      completion: { role: 'none' },
      presentation: { category: 'task-plan', preparingMessage: '正在准备任务计划操作。' },
    },
    runtime: {
      revision: { toolName: input.name, toolRevision, handlerRevision, intentRevision: PREPARED_TOOL_INTENT_REVISION },
      prepare: input.prepare,
      execute: input.execute,
    },
  } satisfies ToolInvocationContribution);
}

function preparedTaskIntent(input: Readonly<{
  input: Record<string, PortableValue>;
  targetIdentity: PortableValue;
  context: Readonly<{
    toolRevision: string;
    handlerRevision: string;
    generation: string;
    descriptor: Readonly<{ flatName: string }>;
    runId: string;
    limits: InvocationLimits;
  }>;
  access: 'read' | 'write';
  concurrency: 'read' | 'write';
  recoveryClass: 'read' | 'idempotent';
  action: string;
}>) {
  return Object.freeze({
    input: Object.freeze(structuredClone(input.input)),
    toolRevision: input.context.toolRevision,
    handlerRevision: input.context.handlerRevision,
    intentRevision: PREPARED_TOOL_INTENT_REVISION,
    targetIdentity: structuredClone(input.targetIdentity),
    generation: input.context.generation,
    action: { summary: input.action },
    permission: {
      toolName: input.context.descriptor.flatName,
      dangerLevel: 'safe' as const,
      readonly: input.access === 'read', access: input.access, recoveryClass: input.recoveryClass,
      actions: [input.access], paths: [], hosts: [], network: false, externalWrite: false,
      destructive: false, credentials: false, admin: false, unknownRisk: false,
      resolvedAddresses: [], targets: [input.targetIdentity],
    },
    access: input.access,
    recoveryClass: input.recoveryClass,
    concurrency: input.concurrency,
    resourceKeys: [`task-plan:${input.context.runId}`],
    limits: input.context.limits,
  });
}

function taskInputSchema(requiredId: boolean): Record<string, PortableValue> {
  return {
    type: 'object', additionalProperties: false, required: requiredId ? ['id', 'title'] : ['title'],
    properties: {
      id: { type: 'string', minLength: 1, maxLength: MAX_TASK_ID_CHARS },
      title: { type: 'string', minLength: 1, maxLength: MAX_TASK_TITLE_CHARS },
      description: { type: 'string', maxLength: MAX_TASK_DESCRIPTION_CHARS },
    },
  };
}

function taskOutputSchema(): Record<string, PortableValue> {
  return {
    type: 'object', additionalProperties: false, required: ['status', 'summary', 'active'],
    properties: {
      status: { type: 'string', enum: ['ok'] }, summary: { type: 'string', maxLength: 512 },
      active: { type: 'boolean' }, goal: { type: 'string', maxLength: MAX_GOAL_CHARS },
      tasks: {
        type: 'array', maxItems: MAX_TASKS,
        items: {
          type: 'object', additionalProperties: false, required: ['id', 'title', 'status'],
          properties: {
            id: { type: 'string', maxLength: MAX_TASK_ID_CHARS },
            title: { type: 'string', maxLength: MAX_TASK_TITLE_CHARS },
            description: { type: 'string', maxLength: MAX_TASK_DESCRIPTION_CHARS },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'] },
          },
        },
      },
    },
  };
}

function boundedTaskInputs(
  value: PortableValue | undefined,
  requireId: boolean,
): Array<{ id?: string; title: string; description?: string }> {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_TASKS) {
    throw expectedToolError('invalid_argument', `tasks must contain 1-${MAX_TASKS} items.`);
  }
  return value.map((item, index) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw expectedToolError('invalid_argument', `tasks[${index}] must be an object.`);
    }
    const task = item as Record<string, PortableValue>;
    const id = optionalBoundedText(task.id, `tasks[${index}].id`, MAX_TASK_ID_CHARS);
    if (requireId && id === undefined) throw expectedToolError('invalid_argument', `tasks[${index}].id is required.`);
    const title = boundedRequiredText(task.title, `tasks[${index}].title`, MAX_TASK_TITLE_CHARS);
    const description = optionalBoundedText(task.description, `tasks[${index}].description`, MAX_TASK_DESCRIPTION_CHARS);
    return { ...(id === undefined ? {} : { id }), title, ...(description === undefined ? {} : { description }) };
  });
}

function createBoundedPlan(input: Parameters<typeof createAgentTaskPlan>[0]): AgentTaskPlan {
  let plan: AgentTaskPlan;
  try {
    plan = createAgentTaskPlan(input);
  } catch (error) {
    if (error instanceof ToolExecutionError) throw error;
    throw expectedToolError('invalid_argument', taskPlanErrorSummary(error));
  }
  return assertBoundedDurablePlan(plan);
}

function taskPlanResult(summary: string, plan: AgentTaskPlan): Record<string, PortableValue> {
  assertBoundedDurablePlan(plan);
  const projection = projectTaskPlan(plan);
  assertPlanPayloadBytes(projection);
  return { status: 'ok', summary, active: true, ...projection };
}

function boundedRequiredText(value: PortableValue | undefined, label: string, maximum: number): string {
  const result = optionalBoundedText(value, label, maximum);
  if (result === undefined) throw expectedToolError('invalid_argument', `${label} is required.`);
  return result;
}

function optionalBoundedText(value: PortableValue | undefined, label: string, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw expectedToolError('invalid_argument', `${label} must contain 1-${maximum} bounded characters.`);
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum) {
    throw expectedToolError('invalid_argument', `${label} must contain 1-${maximum} bounded characters.`);
  }
  if (Buffer.byteLength(normalized, 'utf8') > maximum * 4) {
    throw expectedToolError('limit', `${label} exceeds its UTF-8 byte limit.`);
  }
  return normalized;
}

function optionalTaskStatus(value: PortableValue | undefined): AgentTaskStatus | undefined {
  if (value === undefined) return undefined;
  if (value === 'pending' || value === 'in_progress' || value === 'completed' || value === 'cancelled') return value;
  throw expectedToolError('invalid_argument', 'status is invalid.');
}

function assertPlanPayloadBytes(value: unknown): void {
  let encoded: string;
  try { encoded = JSON.stringify(value); } catch { throw expectedToolError('invalid_argument', 'Task plan payload must be serializable.'); }
  if (Buffer.byteLength(encoded, 'utf8') > MAX_PLAN_BYTES) {
    throw expectedToolError('limit', `Task plan data must not exceed ${MAX_PLAN_BYTES} bytes.`);
  }
}

function assertBoundedDurablePlan(plan: AgentTaskPlan): AgentTaskPlan {
  assertPlanPayloadBytes(plan);
  return plan;
}

function assertTaskCommandBytes(
  command: Readonly<{ kind: string; payload: Record<string, PortableValue> }>,
  plan: AgentTaskPlan,
): void {
  assertBoundedDurablePlan(plan);
  assertPlanPayloadBytes(command.payload);
  assertPlanPayloadBytes(command);
}

function preparedTaskCommand(input: Readonly<Record<string, PortableValue>>): Readonly<{
  command: Parameters<typeof createRuntimeCommandToolResult>[0]['command'];
  result: PortableValue;
}> {
  const command = input.command;
  if (command === null || typeof command !== 'object' || Array.isArray(command)) {
    throw expectedToolError('precondition', 'Prepared task command is invalid.');
  }
  const record = command as Record<string, PortableValue>;
  const kind = record.kind;
  const payload = record.payload;
  if (
    (kind !== 'plan.create' && kind !== 'plan.update') ||
    payload === null || typeof payload !== 'object' || Array.isArray(payload)
  ) {
    throw expectedToolError('precondition', 'Prepared task command is invalid.');
  }
  const payloadRecord = payload as Record<string, PortableValue>;
  const plan = payloadRecord.plan;
  if (plan === null || typeof plan !== 'object' || Array.isArray(plan)) {
    throw expectedToolError('precondition', 'Prepared task plan is invalid.');
  }
  assertPlanPayloadBytes(plan);
  assertPlanPayloadBytes(payloadRecord);
  assertPlanPayloadBytes(record);
  const result = taskPlanResult(
    kind === 'plan.create' ? 'Task plan saved.' : 'Task plan updated.',
    plan as AgentTaskPlan,
  );
  return {
    command: structuredClone(record) as Parameters<typeof createRuntimeCommandToolResult>[0]['command'],
    result,
  };
}

type TaskPlanTargetIdentity = Readonly<{
  kind: 'runtime-task-plan';
  state: 'absent' | 'present';
  runId: string;
  planId?: string;
  revision?: number;
  taskId?: string;
  taskStatus?: AgentTaskStatus;
  taskUpdatedAt?: string;
}>;

function taskPlanTargetIdentity(value: PortableValue): TaskPlanTargetIdentity | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const target = value as Record<string, PortableValue>;
  if (target.kind !== 'runtime-task-plan' || typeof target.runId !== 'string') return undefined;
  if (target.state === 'absent') return { kind: target.kind, state: target.state, runId: target.runId };
  if (
    target.state !== 'present' || typeof target.planId !== 'string' ||
    typeof target.revision !== 'number' || !Number.isSafeInteger(target.revision) || target.revision < 1
  ) return undefined;
  if (target.taskId === undefined) {
    return { kind: target.kind, state: target.state, runId: target.runId, planId: target.planId, revision: target.revision };
  }
  if (
    typeof target.taskId !== 'string' || !isTaskStatus(target.taskStatus) ||
    typeof target.taskUpdatedAt !== 'string'
  ) return undefined;
  return {
    kind: target.kind, state: target.state, runId: target.runId, planId: target.planId,
    revision: target.revision, taskId: target.taskId, taskStatus: target.taskStatus,
    taskUpdatedAt: target.taskUpdatedAt,
  };
}

function isTaskStatus(value: PortableValue | undefined): value is AgentTaskStatus {
  return value === 'pending' || value === 'in_progress' || value === 'completed' || value === 'cancelled';
}

function taskPlanErrorSummary(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message.slice(0, 1_024)
    : 'The task plan cannot be updated.';
}

function requireRuntimeState(
  context: Pick<ToolInvocationExecutionContext, 'runtimeState'>,
): RuntimeCommandProjection {
  if (context.runtimeState === undefined) {
    throw expectedToolError('precondition', 'Runtime control state is unavailable for this invocation.');
  }
  return context.runtimeState;
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
