import type {
  AgentPlan,
  AgentPlanExecuteOptions,
  AgentPlanExecuteResult,
  AgentPlanExecutionSnapshot,
  AgentPlanExecutionSnapshotStatus,
  AgentPlanStep,
  AgentToolExecutionRecord,
} from './types.js';

export type AgentPlanRecoveryAction = 'continue' | 'restart' | 'abandon';

export type AgentPlanRecoveryPlan = {
  planId: string;
  sessionId?: string;
  title: string;
  goal: string;
  interruptedStepId?: string;
  interruptedStepTitle?: string;
  completedStepCount: number;
  failedStepCount: number;
  skippedStepCount: number;
  pendingStepCount: number;
  executedSteps: number;
  totalIterations: number;
  startedAt: string;
  updatedAt: string;
  lastResultText?: string;
  lastToolError?: string;
  resumePrompt: string;
  actions: AgentPlanRecoveryAction[];
};

export type AgentPlanRecoveryStore = {
  save(input: {
    plan: AgentPlan;
    status: AgentPlanExecutionSnapshotStatus;
    session?: AgentPlanExecutionSnapshot['session'];
    finalText?: string;
    executedSteps?: number;
    totalIterations?: number;
    toolExecutions?: AgentToolExecutionRecord[];
    contextCompression?: AgentPlanExecutionSnapshot['contextCompression'];
    errorMessage?: string;
    now?: string;
  }): Promise<AgentPlanExecutionSnapshot>;
  listRecoverable(): Promise<AgentPlanExecutionSnapshot[]>;
  markAbandoned(planId: string, reason?: string, now?: string): Promise<boolean>;
};

export type AgentPlanRecoveryRunner = {
  run(options: AgentPlanExecuteOptions): Promise<AgentPlanExecuteResult>;
};

export type ContinueAgentPlanRecoveryOptions = Omit<
  AgentPlanExecuteOptions,
  'initialPlan' | 'initialSession' | 'initialExecutedSteps' | 'initialTotalIterations' | 'userMessage'
> & {
  userMessage?: string;
  now?: string;
};

export type RestartAgentPlanRecoveryOptions = Omit<
  AgentPlanExecuteOptions,
  'initialPlan' | 'initialSession' | 'initialExecutedSteps' | 'initialTotalIterations' | 'userMessage'
> & {
  userMessage?: string;
  now?: string;
};

export type ContinueAgentPlanRecoveryResult = {
  plan: AgentPlanRecoveryPlan;
  result: AgentPlanExecuteResult;
  abandonedSnapshot: boolean;
};

export type RestartAgentPlanRecoveryResult = ContinueAgentPlanRecoveryResult;

export class AgentPlanRecoveryService {
  constructor(private readonly store: AgentPlanRecoveryStore) {}

  async listRecoverablePlans(): Promise<AgentPlanRecoveryPlan[]> {
    const snapshots = await this.store.listRecoverable();
    return snapshots.map(buildRecoveryPlan).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async abandon(
    planId: string,
    reason = '用户放弃恢复 Plan & Execute 任务',
    now?: string,
  ): Promise<boolean> {
    return this.store.markAbandoned(planId, reason, now);
  }

  async continue(
    planId: string,
    runner: AgentPlanRecoveryRunner,
    options: ContinueAgentPlanRecoveryOptions,
  ): Promise<ContinueAgentPlanRecoveryResult> {
    const { userMessage, now, ...runOptions } = options;
    const snapshot = await this.findRecoverableSnapshot(planId);
    const plan = buildRecoveryPlan(snapshot);
    const resumeMode = options.mode ?? snapshot.session?.mode;
    try {
      const result = await runner.run({
        ...runOptions,
        userMessage: userMessage ?? plan.resumePrompt,
        initialPlan: snapshot.plan,
        ...(snapshot.session === undefined ? {} : { initialSession: snapshot.session }),
        initialExecutedSteps: snapshot.executedSteps,
        initialTotalIterations: snapshot.totalIterations,
        ...(resumeMode === undefined ? {} : { mode: resumeMode }),
      });

      if (!shouldSupersedeRecoverablePlan(result.status)) {
        await this.refreshRecoverableSnapshot(snapshot, now);
        return { plan, result, abandonedSnapshot: false };
      }

      await this.store.save({
        plan: result.plan,
        status: result.status,
        ...(result.session === undefined ? {} : { session: result.session }),
        finalText: result.finalText,
        executedSteps: result.executedSteps,
        totalIterations: result.totalIterations,
        toolExecutions: result.toolExecutions,
        contextCompression: result.contextCompression ?? [],
        ...(now === undefined ? {} : { now }),
      });
      return { plan, result, abandonedSnapshot: true };
    } catch (error) {
      await this.refreshRecoverableSnapshot(snapshot, now);
      throw error;
    }
  }

  async restart(
    planId: string,
    runner: AgentPlanRecoveryRunner,
    options: RestartAgentPlanRecoveryOptions,
  ): Promise<RestartAgentPlanRecoveryResult> {
    const { userMessage, now, ...runOptions } = options;
    const snapshot = await this.findRecoverableSnapshot(planId);
    const plan = buildRecoveryPlan(snapshot);
    const restartMode = options.mode ?? snapshot.session?.mode;
    try {
      const result = await runner.run({
        ...runOptions,
        userMessage: userMessage ?? buildRestartPrompt(plan, snapshot.plan, snapshot.toolExecutions),
        ...(restartMode === undefined ? {} : { mode: restartMode }),
      });

      if (!shouldSupersedeRecoverablePlan(result.status)) {
        await this.refreshRecoverableSnapshot(snapshot, now);
        return { plan, result, abandonedSnapshot: false };
      }

      await this.store.save({
        plan: result.plan,
        status: result.status,
        ...(result.session === undefined ? {} : { session: result.session }),
        finalText: result.finalText,
        executedSteps: result.executedSteps,
        totalIterations: result.totalIterations,
        toolExecutions: result.toolExecutions,
        contextCompression: result.contextCompression ?? [],
        ...(now === undefined ? {} : { now }),
      });
      await this.store.markAbandoned(planId, 'Restarted Plan & Execute task completed successfully.', now);
      return { plan, result, abandonedSnapshot: true };
    } catch (error) {
      await this.refreshRecoverableSnapshot(snapshot, now);
      throw error;
    }
  }

  private async findRecoverableSnapshot(planId: string): Promise<AgentPlanExecutionSnapshot> {
    const snapshot = (await this.store.listRecoverable()).find((item) => item.planId === planId);
    if (!snapshot) {
      throw new Error(`No recoverable Plan & Execute snapshot found for plan ${planId}.`);
    }
    return snapshot;
  }

  private async refreshRecoverableSnapshot(snapshot: AgentPlanExecutionSnapshot, now?: string): Promise<void> {
    await this.store.save({
      plan: snapshot.plan,
      status: 'running',
      ...(snapshot.session === undefined ? {} : { session: snapshot.session }),
      finalText: snapshot.finalText,
      executedSteps: snapshot.executedSteps,
      totalIterations: snapshot.totalIterations,
      toolExecutions: snapshot.toolExecutions,
      contextCompression: snapshot.contextCompression ?? [],
      ...(snapshot.errorMessage === undefined ? {} : { errorMessage: snapshot.errorMessage }),
      ...(now === undefined ? {} : { now }),
    });
  }
}

function buildRecoveryPlan(snapshot: AgentPlanExecutionSnapshot): AgentPlanRecoveryPlan {
  const interruptedStep = firstRecoverableStep(snapshot.plan.steps);
  const lastToolError = lastFailedTool(snapshot.toolExecutions)?.resultPreview;
  const plan: AgentPlanRecoveryPlan = {
    planId: snapshot.planId,
    ...(snapshot.session?.id === undefined ? {} : { sessionId: snapshot.session.id }),
    title: snapshot.plan.title,
    goal: snapshot.plan.goal,
    ...(interruptedStep === undefined
      ? {}
      : {
          interruptedStepId: interruptedStep.id,
          interruptedStepTitle: interruptedStep.title,
        }),
    completedStepCount: snapshot.plan.steps.filter((step) => step.status === 'done').length,
    failedStepCount: snapshot.plan.steps.filter((step) => step.status === 'failed').length,
    skippedStepCount: snapshot.plan.steps.filter((step) => step.status === 'skipped').length,
    pendingStepCount: snapshot.plan.steps.filter((step) => step.status === 'pending' || step.status === 'running').length,
    executedSteps: snapshot.executedSteps,
    totalIterations: snapshot.totalIterations,
    startedAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
    resumePrompt: '',
    actions: ['continue', 'restart', 'abandon'],
    ...(snapshot.finalText ? { lastResultText: snapshot.finalText } : {}),
    ...(lastToolError === undefined ? {} : { lastToolError }),
  };
  return { ...plan, resumePrompt: buildResumePrompt(plan, snapshot.plan, snapshot.toolExecutions) };
}

function firstRecoverableStep(steps: AgentPlanStep[]): AgentPlanStep | undefined {
  return steps.find((step) => step.status === 'running' || step.status === 'pending' || step.status === 'failed');
}

function shouldSupersedeRecoverablePlan(status: AgentPlanExecuteResult['status']): boolean {
  return status === 'done';
}

function buildResumePrompt(
  recoveryPlan: AgentPlanRecoveryPlan,
  plan: AgentPlan,
  toolExecutions: AgentToolExecutionRecord[],
): string {
  const stepSummary = plan.steps
    .map((step, index) => {
      const result = step.resultSummary ? `；结果摘要：${truncateForPrompt(step.resultSummary, 500)}` : '';
      const failure = step.failureReason ? `；失败原因：${truncateForPrompt(step.failureReason, 500)}` : '';
      return `- ${index + 1}. ${step.title} / ${step.status}${result}${failure}`;
    })
    .join('\n');
  const toolSummary =
    toolExecutions.length === 0
      ? '- 尚未完成工具调用。'
      : toolExecutions
          .map((tool, index) => `${index + 1}. ${tool.toolName} / ${tool.status}: ${truncateForPrompt(tool.resultPreview, 600)}`)
          .join('\n');
  const interrupted = recoveryPlan.interruptedStepTitle
    ? `中断步骤：${recoveryPlan.interruptedStepTitle}`
    : '中断步骤：未识别到待执行步骤';
  return [
    '请继续恢复上次中断的 Plan & Execute 任务。',
    `原始目标：${recoveryPlan.goal}`,
    interrupted,
    `已执行步骤数：${recoveryPlan.executedSteps}；累计 ReAct 轮次：${recoveryPlan.totalIterations}。`,
    '计划步骤状态：',
    stepSummary || '- 无计划步骤。',
    '已执行工具摘要：',
    toolSummary,
    '要求：基于已完成步骤继续推进；不要无理由重复已经 done 的步骤；如果必须重跑，请先说明原因。',
  ].join('\n');
}

function buildRestartPrompt(
  recoveryPlan: AgentPlanRecoveryPlan,
  plan: AgentPlan,
  toolExecutions: AgentToolExecutionRecord[],
): string {
  const previousSteps = plan.steps
    .map((step, index) => {
      const result = step.resultSummary ? `; result summary: ${truncateForPrompt(step.resultSummary, 500)}` : '';
      const failure = step.failureReason ? `; failure reason: ${truncateForPrompt(step.failureReason, 500)}` : '';
      return `- ${index + 1}. ${step.title} / ${step.status}${result}${failure}`;
    })
    .join('\n');
  const previousTools =
    toolExecutions.length === 0
      ? '- No completed tool calls before the interruption.'
      : toolExecutions
          .map((tool, index) => `${index + 1}. ${tool.toolName} / ${tool.status}: ${truncateForPrompt(tool.resultPreview, 600)}`)
          .join('\n');
  return [
    'Restart the interrupted Plan & Execute task from a clean plan.',
    `Original goal: ${recoveryPlan.goal}`,
    'Use the previous interrupted work only as context. Do not assume previous steps are complete unless you verify them again.',
    `Interrupted plan: ${recoveryPlan.title}`,
    'Previous plan state:',
    previousSteps || '- No previous plan steps.',
    'Previous tool summary:',
    previousTools,
    'Requirement: create a fresh bounded plan, avoid repeating known mistakes, and continue with the current tool permissions.',
  ].join('\n');
}

function lastFailedTool(toolExecutions: AgentToolExecutionRecord[]): AgentToolExecutionRecord | undefined {
  for (let index = toolExecutions.length - 1; index >= 0; index -= 1) {
    const record = toolExecutions[index];
    if (record?.status === 'failed') return record;
  }
  return undefined;
}

function truncateForPrompt(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}... [truncated ${value.length - maxLength} chars]`;
}

export { AgentPlanRecoveryService as PlanExecuteRecoveryService };
export type {
  AgentPlanRecoveryAction as PlanExecuteRecoveryAction,
  AgentPlanRecoveryPlan as PlanExecuteRecoveryPlan,
  AgentPlanRecoveryRunner as PlanExecuteRecoveryRunner,
  AgentPlanRecoveryStore as PlanExecuteRecoveryStore,
  ContinueAgentPlanRecoveryOptions as ContinuePlanExecuteRecoveryOptions,
  ContinueAgentPlanRecoveryResult as ContinuePlanExecuteRecoveryResult,
  RestartAgentPlanRecoveryOptions as RestartPlanExecuteRecoveryOptions,
  RestartAgentPlanRecoveryResult as RestartPlanExecuteRecoveryResult,
};
