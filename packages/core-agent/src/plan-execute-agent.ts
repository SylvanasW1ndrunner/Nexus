import type { LlmChatRequest, LlmRouter } from '@dbagent/core-llm';
import type { AgentPlanExecutionWriter } from './plan-execute-store.js';
import type { ReactAgent } from './react-agent.js';
import type {
  AgentPlan,
  AgentPlanExecutionSnapshotStatus,
  AgentPlanExecuteOptions,
  AgentPlanExecuteResult,
  AgentPlanStep,
  AgentPlanStepStatus,
  AgentRunOptions,
  AgentRunResult,
  AgentToolExecutionRecord,
  AgentContextCompressionReport,
} from './types.js';

const DEFAULT_MAX_PLAN_STEPS = 8;

export class PlanExecuteAgent {
  constructor(
    private readonly llmRouter: LlmRouter,
    private readonly stepRunner: Pick<ReactAgent, 'run'>,
    private readonly dependencies: PlanExecuteDependencies = {},
  ) {}

  async run(options: AgentPlanExecuteOptions): Promise<AgentPlanExecuteResult> {
    const now = this.dependencies.now ?? (() => new Date().toISOString());
    const plan = clonePlan(options.initialPlan) ?? (await this.createPlan(options, now));
    if (plan.steps.length === 0) {
      await this.saveSnapshot({
        plan,
        status: 'planning_failed',
        finalText: 'Agent planning failed: no executable steps were produced.',
        executedSteps: 0,
        totalIterations: 0,
        toolExecutions: [],
        contextCompression: [],
        now,
      });
      return {
        status: 'planning_failed',
        plan,
        finalText: 'Agent planning failed: no executable steps were produced.',
        executedSteps: 0,
        totalIterations: 0,
        toolExecutions: [],
        contextCompression: [],
      };
    }

    const stopOnStepFailure = options.stopOnStepFailure ?? true;
    const toolExecutions: AgentToolExecutionRecord[] = [];
    const contextCompression: AgentContextCompressionReport[] = [];
    let session = options.initialSession;
    let totalIterations = normalizeNonNegativeInteger(options.initialTotalIterations, 0);
    let executedSteps = normalizeNonNegativeInteger(options.initialExecutedSteps, countExecutedSteps(plan.steps));
    let finalText = '';
    await this.saveSnapshot({
      plan,
      status: 'running',
      ...(session === undefined ? {} : { session }),
      finalText,
      executedSteps,
      totalIterations,
      toolExecutions,
      contextCompression,
      now,
    });

    for (const step of plan.steps) {
      if (isTerminalStep(step)) continue;

      if (options.signal?.aborted) {
        markStep(step, 'skipped', 'Agent run was aborted before this step.');
        const result = {
          status: 'aborted',
          plan,
          ...(session === undefined ? {} : { session }),
          finalText: finalText || 'Agent run was aborted before completing the plan.',
          executedSteps,
          totalIterations,
          toolExecutions,
          contextCompression,
        } satisfies AgentPlanExecuteResult;
        await this.saveResultSnapshot(result, now);
        return result;
      }

      markStep(step, 'running');
      await this.saveSnapshot({
        plan,
        status: 'running',
        ...(session === undefined ? {} : { session }),
        finalText,
        executedSteps,
        totalIterations,
        toolExecutions,
        contextCompression,
        now,
      });
      let result: AgentRunResult;
      try {
        result = await this.stepRunner.run({
          ...toStepRunOptions(options),
          userMessage: buildStepInstruction(plan, step),
          initialIteration: totalIterations,
          ...(session === undefined ? {} : { initialSession: session }),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        markStep(step, 'failed', message);
        await this.saveSnapshot({
          plan,
          status: 'failed',
          ...(session === undefined ? {} : { session }),
          finalText: message,
          executedSteps,
          totalIterations,
          toolExecutions,
          contextCompression,
          errorMessage: message,
          now,
        });
        throw error;
      }
      session = result.session;
      executedSteps += 1;
      totalIterations += result.iterations;
      toolExecutions.push(...result.toolExecutions);
      contextCompression.push(...(result.contextCompression ?? []));
      step.runStatus = result.status;
      step.iterations = result.iterations;
      step.toolExecutions = result.toolExecutions;
      step.resultSummary = limitText(result.finalText, 1200);
      finalText = result.finalText;

      if (isSuccessfulStep(result)) {
        markStep(step, 'done');
        await this.saveSnapshot({
          plan,
          status: 'running',
          session,
          finalText,
          executedSteps,
          totalIterations,
          toolExecutions,
          contextCompression,
          now,
        });
        continue;
      }

      markStep(step, 'failed', result.finalText || result.status);
      if (stopOnStepFailure) {
        skipRemainingSteps(plan.steps, step.id, 'Previous plan step failed.');
        const failedResult = {
          status: result.status === 'aborted' ? 'aborted' : 'failed',
          plan,
          session,
          finalText: failureText(step, result),
          executedSteps,
          totalIterations,
          toolExecutions,
          contextCompression,
        } satisfies AgentPlanExecuteResult;
        await this.saveResultSnapshot(failedResult, now);
        return failedResult;
      }
      await this.saveSnapshot({
        plan,
        status: 'running',
        session,
        finalText,
        executedSteps,
        totalIterations,
        toolExecutions,
        contextCompression,
        now,
      });
    }

    const finalResult = {
      status: plan.steps.some((step) => step.status === 'failed') ? 'failed' : 'done',
      plan,
      ...(session === undefined ? {} : { session }),
      finalText,
      executedSteps,
      totalIterations,
      toolExecutions,
      contextCompression,
    } satisfies AgentPlanExecuteResult;
    await this.saveResultSnapshot(finalResult, now);
    return finalResult;
  }

  private async createPlan(options: AgentPlanExecuteOptions, now: () => string): Promise<AgentPlan> {
    const maxPlanSteps = normalizeMaxPlanSteps(options.maxPlanSteps);
    const request: LlmChatRequest = {
      model: options.model,
      messages: [
        {
          role: 'system',
          content:
            'You are DBAgent planner. Return only JSON with shape {"title":string,"steps":[{"id":string,"title":string,"instruction":string,"dependsOn"?:string[]}]}. Keep steps executable, ordered, and bounded.',
        },
        {
          role: 'user',
          content: `Goal:\n${options.userMessage}\n\nConstraints:\n- Max steps: ${maxPlanSteps}\n- Available tool allowlist: ${
            options.allowedTools?.join(', ') ?? 'all registered tools'
          }\n- Mode: ${options.mode ?? 'ask'}\n- Split inspection, execution, and verification into separate steps only when useful.`,
        },
      ],
      temperature: 0,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    };
    const response = await this.llmRouter.chat(options.providerId, request);
    try {
      return normalizePlan({
        goal: options.userMessage,
        plannerModelText: response.text,
        raw: parsePlannerJson(response.text),
        maxPlanSteps,
        now,
        createPlanId: this.dependencies.createPlanId ?? createPlanId,
      });
    } catch {
      return {
        id: (this.dependencies.createPlanId ?? createPlanId)(),
        title: 'Planning failed',
        goal: options.userMessage,
        createdAt: now(),
        plannerModelText: response.text,
        steps: [],
      };
    }
  }

  private async saveResultSnapshot(result: AgentPlanExecuteResult, now: () => string): Promise<void> {
    await this.saveSnapshot({
      plan: result.plan,
      status: result.status,
      ...(result.session === undefined ? {} : { session: result.session }),
      finalText: result.finalText,
      executedSteps: result.executedSteps,
      totalIterations: result.totalIterations,
      toolExecutions: result.toolExecutions,
      contextCompression: result.contextCompression ?? [],
      now,
    });
  }

  private async saveSnapshot(input: {
    plan: AgentPlan;
    status: AgentPlanExecutionSnapshotStatus;
    session?: AgentRunResult['session'];
    finalText: string;
    executedSteps: number;
    totalIterations: number;
    toolExecutions: AgentToolExecutionRecord[];
    contextCompression: AgentContextCompressionReport[];
    errorMessage?: string;
    now: () => string;
  }): Promise<void> {
    await this.dependencies.planStore?.save({
      plan: input.plan,
      status: input.status,
      ...(input.session === undefined ? {} : { session: input.session }),
      finalText: input.finalText,
      executedSteps: input.executedSteps,
      totalIterations: input.totalIterations,
      toolExecutions: input.toolExecutions,
      contextCompression: input.contextCompression,
      ...(input.errorMessage === undefined ? {} : { errorMessage: input.errorMessage }),
      now: input.now(),
    });
  }
}

export type PlanExecuteDependencies = {
  now?: () => string;
  createPlanId?: () => string;
  planStore?: AgentPlanExecutionWriter;
};

type StepRunBaseOptions = Omit<AgentRunOptions, 'userMessage' | 'initialSession' | 'initialIteration'>;

function toStepRunOptions(options: AgentPlanExecuteOptions): StepRunBaseOptions {
  return {
    providerId: options.providerId,
    model: options.model,
    ...(options.allowedTools === undefined ? {} : { allowedTools: options.allowedTools }),
    ...(options.usageMode === undefined ? {} : { usageMode: options.usageMode }),
    ...(options.mode === undefined ? {} : { mode: options.mode }),
    ...(options.maxIterations === undefined ? {} : { maxIterations: options.maxIterations }),
    ...(options.tokenBudget === undefined ? {} : { tokenBudget: options.tokenBudget }),
    ...(options.contextWindowTokens === undefined ? {} : { contextWindowTokens: options.contextWindowTokens }),
    ...(options.keepRecentMessages === undefined ? {} : { keepRecentMessages: options.keepRecentMessages }),
    ...(options.maxToolResultChars === undefined ? {} : { maxToolResultChars: options.maxToolResultChars }),
    ...(options.maxConsecutiveToolFailures === undefined
      ? {}
      : { maxConsecutiveToolFailures: options.maxConsecutiveToolFailures }),
    ...(options.maxToolExecutionMs === undefined ? {} : { maxToolExecutionMs: options.maxToolExecutionMs }),
    ...(options.taskSafety === undefined ? {} : { taskSafety: options.taskSafety }),
    ...(options.outputSafety === undefined ? {} : { outputSafety: options.outputSafety }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}

function normalizePlan(input: {
  goal: string;
  plannerModelText: string;
  raw: unknown;
  maxPlanSteps: number;
  now: () => string;
  createPlanId: () => string;
}): AgentPlan {
  if (!isRecord(input.raw)) throw new Error('Planner response must be a JSON object.');
  const title = normalizeTitle(input.raw.title, input.goal);
  const rawSteps = Array.isArray(input.raw.steps) ? input.raw.steps : [];
  const steps = rawSteps.slice(0, input.maxPlanSteps).map((rawStep, index) => normalizeStep(rawStep, index));
  if (steps.length === 0) throw new Error('Planner response did not include executable steps.');
  return {
    id: input.createPlanId(),
    title,
    goal: input.goal,
    createdAt: input.now(),
    plannerModelText: input.plannerModelText,
    steps,
  };
}

function normalizeStep(rawStep: unknown, index: number): AgentPlanStep {
  if (!isRecord(rawStep)) {
    throw new Error(`Planner step ${index + 1} must be an object.`);
  }
  const title = normalizeOptionalString(rawStep.title) ?? `Step ${index + 1}`;
  const instruction = normalizeOptionalString(rawStep.instruction);
  if (!instruction) {
    throw new Error(`Planner step ${index + 1} is missing instruction.`);
  }
  const rawId = normalizeOptionalString(rawStep.id);
  const dependsOn = Array.isArray(rawStep.dependsOn)
    ? rawStep.dependsOn.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : undefined;
  return {
    id: sanitizeStepId(rawId ?? `step_${index + 1}`, index),
    title,
    instruction,
    status: 'pending',
    ...(dependsOn && dependsOn.length > 0 ? { dependsOn } : {}),
  };
}

function parsePlannerJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('Planner response is empty.');
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const jsonText = fenced?.[1]?.trim() ?? trimmed;
  return JSON.parse(jsonText);
}

function buildStepInstruction(plan: AgentPlan, step: AgentPlanStep): string {
  const completed = plan.steps
    .filter((candidate) => candidate.status === 'done' && candidate.resultSummary)
    .map((candidate) => `- ${candidate.title}: ${candidate.resultSummary}`)
    .join('\n');
  return [
    `Plan goal: ${plan.goal}`,
    `Current step: ${step.title}`,
    `Instruction: ${step.instruction}`,
    completed ? `Completed step summaries:\n${completed}` : '',
    'Execute only the current step. If a tool is needed, use the available tools under the current permission mode.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

function isSuccessfulStep(result: AgentRunResult): boolean {
  return result.status === 'done' || result.status === 'max_iterations_reached';
}

function isTerminalStep(step: AgentPlanStep): boolean {
  return step.status === 'done' || step.status === 'skipped';
}

function failureText(step: AgentPlanStep, result: AgentRunResult): string {
  return `Plan step failed: ${step.title}. Status: ${result.status}. ${result.finalText}`.trim();
}

function markStep(step: AgentPlanStep, status: AgentPlanStepStatus, failureReason?: string): void {
  step.status = status;
  if (failureReason !== undefined) step.failureReason = failureReason;
}

function skipRemainingSteps(steps: AgentPlanStep[], failedStepId: string, reason: string): void {
  let afterFailedStep = false;
  for (const step of steps) {
    if (step.id === failedStepId) {
      afterFailedStep = true;
      continue;
    }
    if (afterFailedStep && step.status === 'pending') {
      markStep(step, 'skipped', reason);
    }
  }
}

function normalizeTitle(value: unknown, fallback: string): string {
  return normalizeOptionalString(value) ?? (limitText(fallback.trim().replace(/\s+/g, ' '), 80) || 'Agent plan');
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeMaxPlanSteps(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return DEFAULT_MAX_PLAN_STEPS;
  return Math.max(1, Math.min(20, Math.floor(value)));
}

function normalizeNonNegativeInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

function countExecutedSteps(steps: AgentPlanStep[]): number {
  return steps.filter((step) => step.status === 'done' || step.status === 'failed').length;
}

function sanitizeStepId(value: string, index: number): string {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return sanitized || `step_${index + 1}`;
}

function limitText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 15))}...[truncated]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function createPlanId(): string {
  return `plan_${crypto.randomUUID()}`;
}

function clonePlan(plan: AgentPlan | undefined): AgentPlan | undefined {
  return plan === undefined ? undefined : (JSON.parse(JSON.stringify(plan)) as AgentPlan);
}
