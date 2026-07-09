import type { AgentCheckpointWriter, AgentIterationCheckpoint } from './checkpoint-store.js';
import type {
  AgentMessage,
  AgentRunOptions,
  AgentRunResult,
  AgentRunStatus,
  AgentToolExecutionRecord,
} from './types.js';

export type AgentRecoveryAction = 'continue' | 'restart' | 'abandon';

export type AgentRecoveryPlan = {
  sessionId: string;
  title: string;
  userMessage: string;
  interruptedIteration: number;
  startedAt: string;
  updatedAt: string;
  completedToolCount: number;
  failedToolCount: number;
  deniedToolCount: number;
  lastAssistantText?: string;
  lastToolError?: string;
  resumePrompt: string;
  actions: AgentRecoveryAction[];
};

export type AgentRecoveryStore = {
  listRecoverable(): Promise<AgentIterationCheckpoint[]>;
  listBySession(sessionId: string): Promise<AgentIterationCheckpoint[]>;
  markAbandoned(sessionId: string, reason: string, now?: string): Promise<number>;
  markCheckpointAbandoned(checkpointId: string, reason: string, now?: string): Promise<boolean>;
} & AgentCheckpointWriter;

export type AgentRecoveryRunner = {
  run(options: AgentRunOptions): Promise<AgentRunResult>;
};

export type ContinueAgentRecoveryOptions = Omit<
  AgentRunOptions,
  'initialIteration' | 'initialSession' | 'userMessage'
> & {
  userMessage?: string;
  abandonReason?: string;
  now?: string;
};

export type RestartAgentRecoveryOptions = ContinueAgentRecoveryOptions;

export type ContinueAgentRecoveryResult = {
  plan: AgentRecoveryPlan;
  result: AgentRunResult;
  abandonedCheckpointCount: number;
};

export type RestartAgentRecoveryResult = ContinueAgentRecoveryResult;

export class AgentRecoveryService {
  constructor(private readonly store: AgentRecoveryStore) {}

  async listRecoverablePlans(): Promise<AgentRecoveryPlan[]> {
    const checkpoints = await this.store.listRecoverable();
    const plans = await Promise.all(checkpoints.map((checkpoint) => this.buildPlan(checkpoint)));
    return plans.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async abandon(
    sessionId: string,
    reason = '用户放弃恢复 Agent 任务',
    now?: string,
  ): Promise<number> {
    return this.store.markAbandoned(sessionId, reason, now);
  }

  async continue(
    sessionId: string,
    runner: AgentRecoveryRunner,
    options: ContinueAgentRecoveryOptions,
  ): Promise<ContinueAgentRecoveryResult> {
    const { userMessage, abandonReason, now, ...runOptions } = options;
    const checkpoint = await this.findRecoverableCheckpoint(sessionId);
    const plan = await this.buildPlan(checkpoint);
    const result = await runner.run({
      ...runOptions,
      userMessage: userMessage ?? plan.resumePrompt,
      mode: options.mode ?? checkpoint.session.mode,
      initialSession: checkpoint.session,
      initialIteration: checkpoint.iteration,
    });
    if (!shouldSupersedeRecoverableCheckpoint(result.status)) {
      await this.refreshRecoverableCheckpoint(checkpoint, now);
      return { plan, result, abandonedCheckpointCount: 0 };
    }
    const abandoned = await this.store.markCheckpointAbandoned(
      checkpoint.id,
      abandonReason ?? '恢复续跑已接管该 Agent 任务',
      now,
    );
    const abandonedCheckpointCount = abandoned ? 1 : 0;
    return { plan, result, abandonedCheckpointCount };
  }

  async restart(
    sessionId: string,
    runner: AgentRecoveryRunner,
    options: RestartAgentRecoveryOptions,
  ): Promise<RestartAgentRecoveryResult> {
    const { userMessage, abandonReason, now, ...runOptions } = options;
    const checkpoint = await this.findRecoverableCheckpoint(sessionId);
    const plan = await this.buildPlan(checkpoint);
    try {
      const result = await runner.run({
        ...runOptions,
        userMessage: userMessage ?? buildRestartPrompt(plan, checkpoint.toolExecutions),
        mode: options.mode ?? checkpoint.session.mode,
      });
      if (!shouldSupersedeRecoverableCheckpoint(result.status)) {
        await this.refreshRecoverableCheckpoint(checkpoint, now);
        return { plan, result, abandonedCheckpointCount: 0 };
      }
      const abandoned = await this.store.markCheckpointAbandoned(
        checkpoint.id,
        abandonReason ?? 'Restarted Agent task completed successfully.',
        now,
      );
      const abandonedCheckpointCount = abandoned ? 1 : 0;
      return { plan, result, abandonedCheckpointCount };
    } catch (error) {
      await this.refreshRecoverableCheckpoint(checkpoint, now);
      throw error;
    }
  }

  private async buildPlan(checkpoint: AgentIterationCheckpoint): Promise<AgentRecoveryPlan> {
    const history = await this.store.listBySession(checkpoint.sessionId);
    const startedAt = history[0]?.startedAt ?? checkpoint.startedAt;
    const userMessage = firstUserMessage(checkpoint.session.messages) ?? checkpoint.session.title;
    const lastAssistantText = lastMessageContent(checkpoint.session.messages, 'assistant');
    const lastToolError = lastFailedTool(checkpoint.toolExecutions)?.resultPreview;
    const completedToolCount = checkpoint.toolExecutions.filter(
      (item) => item.status === 'success',
    ).length;
    const failedToolCount = checkpoint.toolExecutions.filter(
      (item) => item.status === 'failed',
    ).length;
    const deniedToolCount = checkpoint.toolExecutions.filter(
      (item) => item.status === 'denied',
    ).length;
    const plan: AgentRecoveryPlan = {
      sessionId: checkpoint.sessionId,
      title: checkpoint.session.title,
      userMessage,
      interruptedIteration: checkpoint.iteration,
      startedAt,
      updatedAt: checkpoint.updatedAt,
      completedToolCount,
      failedToolCount,
      deniedToolCount,
      resumePrompt: '',
      actions: ['continue', 'restart', 'abandon'],
      ...(lastAssistantText === undefined ? {} : { lastAssistantText }),
      ...(lastToolError === undefined ? {} : { lastToolError }),
    };
    return { ...plan, resumePrompt: buildResumePrompt(plan, checkpoint.toolExecutions) };
  }

  private async findRecoverableCheckpoint(sessionId: string): Promise<AgentIterationCheckpoint> {
    const checkpoint = (await this.store.listRecoverable()).find(
      (item) => item.sessionId === sessionId,
    );
    if (!checkpoint) {
      throw new Error(`No recoverable Agent checkpoint found for session ${sessionId}.`);
    }
    return checkpoint;
  }

  private async refreshRecoverableCheckpoint(
    checkpoint: AgentIterationCheckpoint,
    now?: string,
  ): Promise<void> {
    await this.store.save({
      session: checkpoint.session,
      iteration: checkpoint.iteration,
      status: 'running',
      toolExecutions: checkpoint.toolExecutions,
      finalText: checkpoint.finalText,
      ...(now === undefined ? {} : { now }),
    });
  }
}

function shouldSupersedeRecoverableCheckpoint(status: AgentRunStatus): boolean {
  return status === 'done';
}

function buildRestartPrompt(
  plan: AgentRecoveryPlan,
  toolExecutions: AgentToolExecutionRecord[],
): string {
  const toolSummary =
    toolExecutions.length === 0
      ? '- No completed tool calls were persisted.'
      : toolExecutions
          .map((tool, index) => {
            const preview = truncateForPrompt(tool.resultPreview, 800);
            return `- ${index + 1}. ${tool.toolName} / ${tool.status}: ${preview}`;
          })
          .join('\n');
  const failure = plan.lastToolError
    ? `\nLatest tool failure: ${truncateForPrompt(plan.lastToolError, 800)}\n`
    : '';
  return [
    'Restart the interrupted Agent task from the beginning.',
    `Original user task: ${plan.userMessage}`,
    `Interrupted at iteration: ${plan.interruptedIteration}.`,
    `Completed tools: ${plan.completedToolCount}; failed tools: ${plan.failedToolCount}; denied tools: ${plan.deniedToolCount}.`,
    failure.trim(),
    'Previous execution summary:',
    toolSummary,
    'Requirement: create a fresh execution path. Use the previous summary only as diagnostic context; do not assume prior tool results are still valid unless you re-check them.',
  ]
    .filter(Boolean)
    .join('\n');
}

function buildResumePrompt(
  plan: AgentRecoveryPlan,
  toolExecutions: AgentToolExecutionRecord[],
): string {
  const toolSummary =
    toolExecutions.length === 0
      ? '- 尚未完成工具调用。'
      : toolExecutions
          .map((tool, index) => {
            const preview = truncateForPrompt(tool.resultPreview, 800);
            return `- ${index + 1}. ${tool.toolName} / ${tool.status}: ${preview}`;
          })
          .join('\n');

  const failure = plan.lastToolError
    ? `\n最近一次工具失败：${truncateForPrompt(plan.lastToolError, 800)}\n`
    : '';
  return [
    '请继续恢复上次中断的 Agent 任务。',
    `原始用户任务：${plan.userMessage}`,
    `中断位置：第 ${plan.interruptedIteration} 轮。`,
    `已成功工具数：${plan.completedToolCount}，失败工具数：${plan.failedToolCount}，拒绝工具数：${plan.deniedToolCount}。`,
    failure.trim(),
    '已执行工具摘要：',
    toolSummary,
    '要求：基于已完成结果继续推进；不要无理由重复已经成功的工具调用；如果必须重跑，请先说明原因。',
  ]
    .filter(Boolean)
    .join('\n');
}

function firstUserMessage(messages: AgentMessage[]): string | undefined {
  return messages.find((message) => message.role === 'user')?.content;
}

function lastMessageContent(
  messages: AgentMessage[],
  role: AgentMessage['role'],
): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === role) return message.content;
  }
  return undefined;
}

function lastFailedTool(
  toolExecutions: AgentToolExecutionRecord[],
): AgentToolExecutionRecord | undefined {
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
