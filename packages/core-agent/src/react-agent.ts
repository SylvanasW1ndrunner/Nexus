import type { LlmChatRequest, LlmChatResponse, LlmRouter } from '@dbagent/core-llm';
import type { RoundContext, UsageTracker } from '@dbagent/core-usage';
import type { AgentCheckpointWriter } from './checkpoint-store.js';
import { buildAgentContext } from './context-manager.js';
import { PermissionManager } from './permission-manager.js';
import { addUsage, appendMessage, createAgentSession, createMessage } from './session.js';
import { redactPersistedAgentValue } from './redaction.js';
import type { AgentSessionWriter } from './session-store.js';
import { persistAgentStreamEvents } from './stream-store.js';
import type { AgentStreamStore } from './stream-store.js';
import type { ToolRegistry } from './tool-registry.js';
import type {
  AgentRunDependencies,
  AgentRunOptions,
  AgentRunResult,
  AgentToolContext,
  AgentToolExecutionRecord,
  AgentToolHandler,
  ApprovalProvider,
} from './types.js';

const DEFAULT_MAX_PERSISTED_TOOL_RESULT_CHARS = 12_000;
const DEFAULT_MAX_PERSISTED_TOOL_ARGUMENT_CHARS = 4_000;

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
    const maxToolResultChars = normalizePositiveInteger(
      options.maxToolResultChars,
      DEFAULT_MAX_PERSISTED_TOOL_RESULT_CHARS,
    );
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
              toolCall.arguments,
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
            const record = executionRecord(
              toolCall.id,
              toolCall.name,
              'failed',
              startedAt,
              toolCall.arguments,
              'Tool is not registered.',
            );
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

          const permission = await this.permissionManager.checkDetailed({
            mode: session.mode,
            tool,
            toolCall,
          });

          if (permission.decision !== 'allow') {
            const record = executionRecord(
              toolCall.id,
              tool.name,
              'denied',
              startedAt,
              toolCall.arguments,
              `Permission: ${permission.decision}`,
            );
            toolExecutions.push(record);
            await saveCheckpoint(iteration, 'running');
            appendMessage(
              session,
              createMessage(
                {
                  role: 'tool',
                  toolCallId: toolCall.id,
                  toolName: tool.name,
                  content: JSON.stringify({ error: 'Permission denied.', permission: permission.decision }),
                },
                this.now,
              ),
            );
            await this.saveSession(session);
            await saveCheckpoint(iteration, 'running');
            if (permission.decision === 'deny') {
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
              ...(permission.source === 'approval-provider'
                ? {
                    approval: {
                      granted: true,
                      source: permission.source,
                      toolCallId: toolCall.id,
                      toolName: tool.name,
                      approvedAt: this.now(),
                    } as const,
                  }
                : {}),
            };
            const result = await executeToolWithTimeout(
              tool.name,
              tool.handler,
              toolCall.arguments,
              context,
              maxToolExecutionMs,
            );
            const preview = serializeToolResult(result, maxToolResultChars);
            toolExecutions.push(
              executionRecord(toolCall.id, tool.name, 'success', startedAt, toolCall.arguments, preview),
            );
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
            const message = limitSerializedToolResult(error instanceof Error ? error.message : String(error), maxToolResultChars);
            const record = executionRecord(
              toolCall.id,
              tool.name,
              'failed',
              startedAt,
              toolCall.arguments,
              message,
            );
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

function serializeToolResult(result: unknown, maxChars: number): string {
  return limitSerializedToolResult(stringifyToolResult(result), maxChars);
}

function serializeToolArguments(args: Record<string, unknown>): string {
  return limitSerializedToolResult(
    stringifyToolResult(redactPersistedAgentValue(args)),
    DEFAULT_MAX_PERSISTED_TOOL_ARGUMENT_CHARS,
  );
}

function stringifyToolResult(result: unknown): string {
  if (typeof result === 'string') return result;
  try {
    const serialized = JSON.stringify(result);
    return serialized === undefined ? String(result) : serialized;
  } catch (error) {
    return JSON.stringify({
      error: 'Tool result could not be serialized.',
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

function limitSerializedToolResult(content: string, maxChars: number): string {
  const limit = normalizePositiveInteger(maxChars, DEFAULT_MAX_PERSISTED_TOOL_RESULT_CHARS);
  if (content.length <= limit) return content;

  if (limit < 160) {
    const suffix = '...[truncated]';
    return `${content.slice(0, Math.max(0, limit - suffix.length))}${suffix}`;
  }

  let headLength = Math.max(40, Math.floor(limit * 0.42));
  let tailLength = Math.max(24, Math.floor(limit * 0.18));
  while (headLength > 20 && tailLength > 12) {
    const summary = JSON.stringify({
      truncated: true,
      reason: 'tool_result_too_large',
      summary: '工具结果已在本地摘要，保留开头、结尾和原始长度，避免超过模型上下文。',
      originalChars: content.length,
      head: content.slice(0, headLength),
      tail: content.slice(-tailLength),
    });
    if (summary.length <= limit) return summary;
    headLength = Math.floor(headLength * 0.85);
    tailLength = Math.floor(tailLength * 0.85);
  }

  const suffix = '...[truncated]';
  return `${content.slice(0, Math.max(0, limit - suffix.length))}${suffix}`;
}

function executionRecord(
  toolCallId: string,
  toolName: string,
  status: AgentToolExecutionRecord['status'],
  startedAt: number,
  args: Record<string, unknown>,
  resultPreview: string,
): AgentToolExecutionRecord {
  const argumentPreview = serializeToolArguments(args);
  return {
    toolCallId,
    toolName,
    status,
    durationMs: Math.max(0, Date.now() - startedAt),
    ...(argumentPreview === '{}' ? {} : { argumentPreview }),
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

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function toolTimeoutMessage(toolName: string, timeoutMs: number): string {
  return `工具 ${toolName} 执行超时（${timeoutMs}ms）。`;
  return `工具 ${toolName} 执行超时（${timeoutMs}ms）。`;
}
