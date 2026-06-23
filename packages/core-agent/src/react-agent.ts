import type { LlmChatRequest, LlmChatResponse, LlmRouter } from '@dbagent/core-llm';
import type { RoundContext, UsageTracker } from '@dbagent/core-usage';
import type { AgentCheckpointWriter } from './checkpoint-store.js';
import { buildAgentContext } from './context-manager.js';
import { PermissionManager } from './permission-manager.js';
import { addUsage, appendMessage, createAgentSession, createMessage } from './session.js';
import type { AgentSessionWriter } from './session-store.js';
import { AgentStreamStore, persistAgentStreamEvents } from './stream-store.js';
import { ToolRegistry } from './tool-registry.js';
import type {
  AgentRunDependencies,
  AgentRunOptions,
  AgentRunResult,
  AgentToolContext,
  AgentToolExecutionRecord,
  AgentToolHandler,
  ApprovalProvider,
} from './types.js';

export class ReactAgent {
  private readonly permissionManager: PermissionManager;
  private readonly now: () => string;
  private readonly createSessionId: () => string;
  private readonly checkpointStore: AgentCheckpointWriter | undefined;
  private readonly sessionStore: AgentSessionWriter | undefined;
  private readonly streamStore: AgentStreamStore | undefined;

  constructor(
    private readonly llmRouter: LlmRouter,
    private readonly toolRegistry: ToolRegistry,
    private readonly usageTracker: UsageTracker,
    approvalProvider?: ApprovalProvider,
    dependencies: AgentRunDependencies = {},
  ) {
    this.permissionManager = new PermissionManager(approvalProvider);
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.createSessionId = dependencies.createSessionId ?? (() => crypto.randomUUID());
    this.checkpointStore = dependencies.checkpointStore;
    this.sessionStore = dependencies.sessionStore;
    this.streamStore = dependencies.streamStore;
  }

  async run(options: AgentRunOptions): Promise<AgentRunResult> {
    const session = createAgentSession({
      id: this.createSessionId(),
      title: titleFromMessage(options.userMessage),
      mode: options.mode ?? 'ask',
      now: this.now,
    });
    appendMessage(session, createMessage({ role: 'user', content: options.userMessage }, this.now));
    await this.saveSession(session);

    const usageMode = options.usageMode ?? 'byok';
    if (usageMode === 'subscription') {
      const quota = await this.usageTracker.getCurrentQuota('subscription');
      if (quota.exceeded) {
        return {
          status: 'quota_exceeded',
          session,
          finalText: 'Usage quota exceeded.',
          iterations: 0,
          toolExecutions: [],
        };
      }
    }

    const round = await this.usageTracker.startConversationRound(session.id, usageMode);
    let roundClosed = false;
    const closeRound = async (status: 'success' | 'aborted' | 'failed', errorMessage?: string) => {
      if (roundClosed) return;
      roundClosed = true;
      await this.usageTracker.endConversationRound(round, status, errorMessage);
    };

    const toolExecutions: AgentToolExecutionRecord[] = [];
    const maxIterations = options.maxIterations ?? 25;
    const maxConsecutiveToolFailures = options.maxConsecutiveToolFailures ?? 3;
    const maxToolExecutionMs = options.maxToolExecutionMs ?? 60_000;
    const allowedToolSet = options.allowedTools === undefined ? undefined : new Set(options.allowedTools);
    let finalText = '';
    let currentIteration = 0;
    let consecutiveToolFailures = 0;
    const saveCheckpoint = async (
      iteration: number,
      status: 'running' | 'done' | 'aborted' | 'failed',
      errorMessage?: string,
    ) => {
      await this.checkpointStore?.save({
        session,
        iteration,
        status,
        toolExecutions,
        finalText,
        ...(errorMessage === undefined ? {} : { errorMessage }),
        now: this.now(),
      });
    };

    try {
      for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
        currentIteration = iteration;
        if (options.signal?.aborted || session.aborted) {
          await saveCheckpoint(iteration - 1, 'aborted');
          await this.saveSession(session);
          await closeRound('aborted');
          return { status: 'aborted', session, finalText, iterations: iteration - 1, toolExecutions };
        }

        await saveCheckpoint(iteration, 'running');
        const context = buildAgentContext(session, this.toolRegistry.llmTools(options.allowedTools), {
          ...(options.contextWindowTokens === undefined ? {} : { maxPromptTokens: options.contextWindowTokens }),
          ...(options.keepRecentMessages === undefined ? {} : { keepRecentMessages: options.keepRecentMessages }),
          ...(options.maxToolResultChars === undefined ? {} : { maxToolResultChars: options.maxToolResultChars }),
        });
        const request = {
          model: options.model,
          messages: context.messages,
          tools: context.tools,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        };
        const response = await this.callModel({
          providerId: options.providerId,
          model: options.model,
          request,
          round,
          sessionId: session.id,
        });
        addUsage(session, response.usage);

        appendMessage(
          session,
          createMessage({ role: 'assistant', content: response.text, toolCalls: response.toolCalls }, this.now),
        );
        await this.saveSession(session);
        await saveCheckpoint(iteration, 'running');

        if (response.usage?.totalTokens && options.tokenBudget && session.tokenUsage.totalTokens > options.tokenBudget) {
          finalText = 'Token budget exceeded.';
          await saveCheckpoint(iteration, 'done');
          await this.saveSession(session);
          await closeRound('success');
          return {
            status: 'max_iterations_reached',
            session,
            finalText,
            iterations: iteration,
            toolExecutions,
          };
        }

        if (response.toolCalls.length === 0) {
          finalText = response.text;
          await saveCheckpoint(iteration, 'done');
          await this.saveSession(session);
          await closeRound('success');
          return { status: 'done', session, finalText, iterations: iteration, toolExecutions };
        }

        for (const toolCall of response.toolCalls) {
          const startedAt = Date.now();
          if (allowedToolSet !== undefined && !allowedToolSet.has(toolCall.name)) {
            const record = executionRecord(
              toolCall.id,
              toolCall.name,
              'denied',
              startedAt,
              'Tool not allowed by run policy.',
            );
            toolExecutions.push(record);
            await saveCheckpoint(iteration, 'running');
            appendMessage(
              session,
              createMessage(
                {
                  role: 'tool',
                  toolCallId: toolCall.id,
                  toolName: toolCall.name,
                  content: JSON.stringify({ error: 'Tool is not allowed for this run.' }),
                },
                this.now,
              ),
            );
            await this.saveSession(session);
            finalText = 'Tool is not allowed for this run.';
            await saveCheckpoint(iteration, 'done');
            await closeRound('success');
            return {
              status: 'permission_denied',
              session,
              finalText,
              iterations: iteration,
              toolExecutions,
            };
          }

          const tool = this.toolRegistry.get(toolCall.name);
          if (!tool) {
            const record = executionRecord(toolCall.id, toolCall.name, 'failed', startedAt, 'Tool is not registered.');
            toolExecutions.push(record);
            consecutiveToolFailures += 1;
            await saveCheckpoint(iteration, 'running');
            appendMessage(
              session,
              createMessage(
                {
                  role: 'tool',
                  toolCallId: toolCall.id,
                  toolName: toolCall.name,
                  content: JSON.stringify({ error: 'Tool is not registered.' }),
                },
                this.now,
              ),
            );
            await this.saveSession(session);
            await saveCheckpoint(iteration, 'running');
            if (consecutiveToolFailures >= maxConsecutiveToolFailures) {
              finalText = failureStopText(consecutiveToolFailures, record.resultPreview);
              await saveCheckpoint(iteration, 'failed', finalText);
              await closeRound('failed', finalText);
              return {
                status: 'tool_failed',
                session,
                finalText,
                iterations: iteration,
                toolExecutions,
              };
            }
            continue;
          }

          const permission = await this.permissionManager.check({
            mode: session.mode,
            tool,
            toolCall,
          });

          if (permission !== 'allow') {
            const record = executionRecord(toolCall.id, tool.name, 'denied', startedAt, `Permission: ${permission}`);
            toolExecutions.push(record);
            await saveCheckpoint(iteration, 'running');
            appendMessage(
              session,
              createMessage(
                {
                  role: 'tool',
                  toolCallId: toolCall.id,
                  toolName: tool.name,
                  content: JSON.stringify({ error: 'Permission denied.', permission }),
                },
                this.now,
              ),
            );
            await this.saveSession(session);
            await saveCheckpoint(iteration, 'running');
            if (permission === 'deny') {
              finalText = 'Permission denied.';
              await saveCheckpoint(iteration, 'done');
              await this.saveSession(session);
              await closeRound('success');
              return {
                status: 'permission_denied',
                session,
                finalText,
                iterations: iteration,
                toolExecutions,
              };
            }
            continue;
          }

          try {
            const context = {
              session,
              ...(options.signal === undefined ? {} : { signal: options.signal }),
            };
            const result = await executeToolWithTimeout(
              tool.name,
              tool.handler,
              toolCall.arguments,
              context,
              maxToolExecutionMs,
            );
            const preview = serializeToolResult(result);
            toolExecutions.push(executionRecord(toolCall.id, tool.name, 'success', startedAt, preview));
            consecutiveToolFailures = 0;
            appendMessage(
              session,
              createMessage(
                {
                  role: 'tool',
                  toolCallId: toolCall.id,
                  toolName: tool.name,
                  content: preview,
                },
                this.now,
              ),
            );
            await this.saveSession(session);
            await saveCheckpoint(iteration, 'running');
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const record = executionRecord(toolCall.id, tool.name, 'failed', startedAt, message);
            toolExecutions.push(record);
            consecutiveToolFailures += 1;
            appendMessage(
              session,
              createMessage(
                {
                  role: 'tool',
                  toolCallId: toolCall.id,
                  toolName: tool.name,
                  content: JSON.stringify({ error: message }),
                },
                this.now,
              ),
            );
            await this.saveSession(session);
            await saveCheckpoint(iteration, 'running');
            if (consecutiveToolFailures >= maxConsecutiveToolFailures) {
              finalText = failureStopText(consecutiveToolFailures, record.resultPreview);
              await saveCheckpoint(iteration, 'failed', finalText);
              await this.saveSession(session);
              await closeRound('failed', finalText);
              return {
                status: 'tool_failed',
                session,
                finalText,
                iterations: iteration,
                toolExecutions,
              };
            }
          }
        }
      }

      finalText = 'Max iterations reached.';
      await saveCheckpoint(maxIterations, 'done');
      await this.saveSession(session);
      await closeRound('success');
      return {
        status: 'max_iterations_reached',
        session,
        finalText,
        iterations: maxIterations,
        toolExecutions,
      };
    } catch (error) {
      const status = options.signal?.aborted || session.aborted ? 'aborted' : 'failed';
      const message = error instanceof Error ? error.message : String(error);
      await saveCheckpoint(currentIteration, status, message);
      await this.saveSession(session);
      await closeRound(status, message);
      throw error;
    }
  }

  private async saveSession(session: Parameters<AgentSessionWriter['save']>[0]['session']): Promise<void> {
    await this.sessionStore?.save({ session, now: this.now() });
  }

  private async callModel(input: {
    providerId: string;
    model: string;
    request: LlmChatRequest;
    round: RoundContext;
    sessionId: string;
  }): Promise<LlmChatResponse> {
    if (!this.streamStore) {
      return this.llmRouter.chat(input.providerId, input.request, { round: input.round });
    }

    const stream = await this.streamStore.start({
      sessionId: input.sessionId,
      roundId: input.round.id,
      providerId: input.providerId,
      model: input.model,
      now: this.now(),
    });

    let response: LlmChatResponse | undefined;
    const events = this.llmRouter.stream(input.providerId, input.request, { round: input.round });
    for await (const event of persistAgentStreamEvents(this.streamStore, stream.id, events, this.now)) {
      if (event.type === 'finish') response = event.response;
    }

    if (!response) {
      throw new Error('LLM stream ended without a finish event.');
    }
    return response;
  }
}

function titleFromMessage(message: string): string {
  const trimmed = message.trim().replace(/\s+/g, ' ');
  return trimmed.length > 24 ? `${trimmed.slice(0, 24)}...` : trimmed || '新会话';
}

function serializeToolResult(result: unknown): string {
  if (typeof result === 'string') return result;
  return JSON.stringify(result);
}

function executionRecord(
  toolCallId: string,
  toolName: string,
  status: AgentToolExecutionRecord['status'],
  startedAt: number,
  resultPreview: string,
): AgentToolExecutionRecord {
  return {
    toolCallId,
    toolName,
    status,
    durationMs: Math.max(0, Date.now() - startedAt),
    resultPreview,
  };
}

function failureStopText(failureCount: number, lastError: string): string {
  return `连续 ${failureCount} 次工具执行失败，已停止 Agent 任务。最后一次错误：${lastError}`;
}

async function executeToolWithTimeout(
  toolName: string,
  handler: AgentToolHandler,
  args: Record<string, unknown>,
  context: AgentToolContext,
  timeoutMs: number,
): Promise<unknown> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return handler(args, context);
  }

  const controller = new AbortController();
  const parentSignal = context.signal;
  if (parentSignal?.aborted) {
    throw new Error('Agent run was aborted before tool execution.');
  }

  let timedOut = false;
  const abortFromParent = () => controller.abort(parentSignal?.reason);
  parentSignal?.addEventListener('abort', abortFromParent, { once: true });

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    const rejectOnAbort = () => {
      reject(
        new Error(timedOut ? toolTimeoutMessage(toolName, timeoutMs) : 'Agent run was aborted during tool execution.'),
      );
    };
    controller.signal.addEventListener('abort', rejectOnAbort, { once: true });
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(toolTimeoutMessage(toolName, timeoutMs)));
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      Promise.resolve(handler(args, { ...context, signal: controller.signal })),
      timeoutPromise,
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    parentSignal?.removeEventListener('abort', abortFromParent);
  }
}

function toolTimeoutMessage(toolName: string, timeoutMs: number): string {
  return `工具 ${toolName} 执行超时（${timeoutMs}ms）。`;
}
