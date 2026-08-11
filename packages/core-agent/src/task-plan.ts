import { randomUUID } from 'node:crypto';
import type { AgentTaskEvidence, AgentTaskItem, AgentTaskPlan, AgentTaskStatus } from './types.js';

export type CreateAgentTaskPlanInput = {
  goal: string;
  tasks: Array<{
    id?: string;
    title: string;
    description?: string;
    acceptanceCriteria?: string[];
    dependsOn?: string[];
  }>;
  now?: string;
  createId?: () => string;
};

export type UpdateAgentTaskInput = {
  taskId: string;
  status?: AgentTaskStatus;
  title?: string;
  description?: string;
  acceptanceCriteria?: string[];
  evidence?: Omit<AgentTaskEvidence, 'createdAt'> & { createdAt?: string };
  now?: string;
};

export type AgentTaskPlanProjection = Readonly<{
  planId: string;
  revision: number;
  plan: AgentTaskPlan;
}>;

export type AgentTaskPlanFact =
  | Readonly<{ type: 'plan.created'; planId: string; revision: 1; plan: AgentTaskPlan }>
  | Readonly<{ type: 'plan.updated'; planId: string; revision: number; plan: AgentTaskPlan }>;

/**
 * Pure plan projector. A plan is optional model-visible working state; it is
 * never accepted as delivery evidence or as the Run completion predicate.
 */
export function applyAgentTaskPlanFact(
  current: AgentTaskPlanProjection | undefined,
  fact: AgentTaskPlanFact,
): AgentTaskPlanProjection {
  if (fact.type === 'plan.created') {
    if (current !== undefined || fact.revision !== 1) {
      throw new Error('Task plan creation conflicts with the persisted projection.');
    }
  } else {
    if (
      current === undefined || current.planId !== fact.planId ||
      fact.revision !== current.revision + 1
    ) {
      throw new Error('Task plan update revision conflicts with the persisted projection.');
    }
  }
  return deepFreezePlan({
    planId: fact.planId, revision: fact.revision, plan: structuredClone(fact.plan),
  });
}

export function createAgentTaskPlan(input: CreateAgentTaskPlanInput): AgentTaskPlan {
  const goal = requireText(input.goal, 'goal');
  if (input.tasks.length === 0) {
    throw new Error('A task plan requires at least one task.');
  }
  const now = input.now ?? new Date().toISOString();
  const createId = input.createId ?? randomUUID;
  const ids = new Set<string>();
  const tasks: AgentTaskItem[] = input.tasks.map((task, index) => {
    const id = requireText(task.id ?? `task-${index + 1}-${createId().slice(0, 8)}`, 'task id');
    if (ids.has(id)) throw new Error(`Duplicate task id: ${id}.`);
    ids.add(id);
    const description = optionalText(task.description);
    return {
      id,
      title: requireText(task.title, 'task title'),
      ...(description === undefined ? {} : { description }),
      status: 'pending' as const,
      acceptanceCriteria: normalizedTextList(task.acceptanceCriteria, 'acceptance criteria'),
      dependsOn: normalizedTextList(task.dependsOn, 'task dependency'),
      evidence: [],
      createdAt: now,
      updatedAt: now,
    };
  });
  validateDependencies(tasks);
  return {
    version: 1,
    goal,
    tasks,
    createdAt: now,
    updatedAt: now,
  };
}

export function updateAgentTask(plan: AgentTaskPlan, input: UpdateAgentTaskInput): AgentTaskPlan {
  const taskId = requireText(input.taskId, 'taskId');
  const index = plan.tasks.findIndex((task) => task.id === taskId);
  if (index === -1) throw new Error(`Task not found: ${taskId}.`);
  const current = plan.tasks[index]!;
  const now = input.now ?? new Date().toISOString();
  const status = input.status ?? current.status;

  assertTaskTransition(current.status, status);
  if (status === 'in_progress' || status === 'completed') {
    const other = plan.tasks.find((task) => task.id !== taskId && task.status === 'in_progress');
    if (status === 'in_progress' && other) {
      throw new Error(
        `Task ${other.id} is already in progress. Update it before starting ${taskId}.`,
      );
    }
    const incompleteDependency = current.dependsOn.find(
      (dependencyId) => plan.tasks.find((task) => task.id === dependencyId)?.status !== 'completed',
    );
    if (incompleteDependency) {
      throw new Error(`Task ${taskId} depends on incomplete task ${incompleteDependency}.`);
    }
  }

  const evidence =
    input.evidence === undefined
      ? current.evidence
      : [...current.evidence, normalizeEvidence(input.evidence, now)];
  const nextDescription =
    input.description === undefined ? current.description : optionalText(input.description);
  const currentWithoutDescription = { ...current };
  delete currentWithoutDescription.description;
  const updated: AgentTaskItem = {
    ...currentWithoutDescription,
    ...(nextDescription === undefined ? {} : { description: nextDescription }),
    ...(input.title === undefined ? {} : { title: requireText(input.title, 'task title') }),
    ...(input.acceptanceCriteria === undefined
      ? {}
      : {
          acceptanceCriteria: normalizedTextList(input.acceptanceCriteria, 'acceptance criteria'),
        }),
    status,
    evidence,
    updatedAt: now,
  };
  const tasks = [...plan.tasks];
  tasks[index] = updated;
  return { ...plan, tasks, updatedAt: now };
}

function normalizeEvidence(
  evidence: NonNullable<UpdateAgentTaskInput['evidence']>,
  now: string,
): AgentTaskEvidence {
  const reference = optionalText(evidence.reference);
  return {
    kind: evidence.kind,
    summary: requireText(evidence.summary, 'evidence summary'),
    ...(reference === undefined ? {} : { reference }),
    createdAt: evidence.createdAt ?? now,
  };
}

export function currentAgentTask(plan: AgentTaskPlan | undefined): AgentTaskItem | undefined {
  return plan?.tasks.find((task) => task.status === 'in_progress');
}

export function unresolvedAgentTasks(plan: AgentTaskPlan | undefined): AgentTaskItem[] {
  return (
    plan?.tasks.filter((task) => task.status !== 'completed' && task.status !== 'cancelled') ?? []
  );
}

export function isAgentTaskPlanComplete(plan: AgentTaskPlan | undefined): boolean {
  return plan !== undefined && unresolvedAgentTasks(plan).length === 0;
}

export function renderAgentTaskPlanContext(plan: AgentTaskPlan | undefined): string | undefined {
  if (!plan) return undefined;
  const tasks = plan.tasks
    .map((task) => `- [${task.status}] ${task.id}: ${task.title}`)
    .join('\n');
  return [
    '<task_plan>',
    `Goal: ${plan.goal}`,
    tasks,
    'Keep this plan concise and update it when useful. Runtime tool outcomes independently verify completion.',
    '</task_plan>',
  ].join('\n');
}

function assertTaskTransition(from: AgentTaskStatus, to: AgentTaskStatus): void {
  if (from === to) return;
  if (from === 'completed' || from === 'cancelled') {
    throw new Error(`Task cannot transition from ${from} to ${to}.`);
  }
  const allowed: Record<AgentTaskStatus, AgentTaskStatus[]> = {
    pending: ['in_progress', 'completed', 'cancelled'],
    in_progress: ['pending', 'completed', 'cancelled'],
    completed: [],
    cancelled: [],
  };
  if (!allowed[from].includes(to)) {
    throw new Error(`Invalid task transition from ${from} to ${to}.`);
  }
}

function validateDependencies(tasks: AgentTaskItem[]): void {
  const ids = new Set(tasks.map((task) => task.id));
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) {
        throw new Error(`Task ${task.id} depends on unknown task ${dependency}.`);
      }
      if (dependency === task.id) {
        throw new Error(`Task ${task.id} cannot depend on itself.`);
      }
    }
  }
  for (const task of tasks) {
    assertAcyclicTask(task.id, tasks, new Set(), new Set());
  }
}

function assertAcyclicTask(
  taskId: string,
  tasks: AgentTaskItem[],
  visiting: Set<string>,
  visited: Set<string>,
): void {
  if (visited.has(taskId)) return;
  if (visiting.has(taskId)) {
    throw new Error(`Task dependency cycle detected at ${taskId}.`);
  }
  visiting.add(taskId);
  const task = tasks.find((item) => item.id === taskId);
  for (const dependency of task?.dependsOn ?? []) {
    assertAcyclicTask(dependency, tasks, visiting, visited);
  }
  visiting.delete(taskId);
  visited.add(taskId);
}

function normalizedTextList(input: string[] | undefined, name: string): string[] {
  if (input === undefined) return [];
  return [...new Set(input.map((item) => requireText(item, name)))];
}

function optionalText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function requireText(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} is required.`);
  return normalized;
}

function deepFreezePlan<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  Object.values(value).forEach((item) => deepFreezePlan(item, seen));
  return Object.freeze(value);
}
