import type {
  LlmChatRequest,
  LlmChatResponse,
  LlmMessage,
  LlmRouter,
  LlmTool,
} from '@dbagent/core-llm';
import type { RoundContext, UsageTracker } from '@dbagent/core-usage';
import type { AgentAuditLogWriter, AgentAuditRunStatus } from './audit-log-store.js';
import type { AgentCheckpointWriter } from './checkpoint-store.js';
import {
  buildAgentContext,
  buildAgentContextCompactionRequest,
  buildDeterministicContextSummary,
  compactionAppliedReport,
  createAgentContextCheckpoint,
  createAgentContextCompactionPlan,
  type AgentContextBuildOutput,
  type AgentContextManagerOptions,
} from './context-manager.js';
import {
  blockedAgentFinalText,
  blockedAgentToolResultMessage,
  sanitizeAgentOutputText,
  sanitizeAgentOutputValue,
} from './output-safety.js';
import { PermissionManager } from './permission-manager.js';
import { addUsage, appendMessage, createAgentSession, createMessage } from './session.js';
import { redactPersistedAgentValue } from './redaction.js';
import type { AgentSessionWriter } from './session-store.js';
import { persistAgentStreamEvents } from './stream-store.js';
import type { AgentStreamStore } from './stream-store.js';
import { assessAgentTaskSafety } from './task-safety.js';
import { classifyAgentToolFailure } from './tool-failure-classifier.js';
import type { ToolRegistry } from './tool-registry.js';
import type {
  AgentSession,
  AgentRunDependencies,
  AgentRunOptions,
  AgentRunResult,
  AgentToolContext,
  AgentToolApproval,
  AgentToolApprovalRecord,
  AgentToolExecutionRecord,
  AgentToolHandler,
  AgentContextCompressionReport,
  AgentContextCompactionResult,
  AgentManualContextCompactionOptions,
  AgentOutputRedactionReason,
  ApprovalProvider,
} from './types.js';

const DEFAULT_MAX_PERSISTED_TOOL_RESULT_CHARS = 12_000;
const DEFAULT_MAX_PERSISTED_TOOL_ARGUMENT_CHARS = 4_000;
const DEFAULT_AGENT_USER_ID = 'local-user';
const PREFERENCE_CONTEXT_PREFIX = '用户长期偏好（自动提炼，可由用户修改或删除）：';
const MAX_AUTO_COMPACTIONS_PER_ITERATION = 2;
const MIN_COMPACTION_REDUCTION_RATIO = 0.05;
const MAX_COMPACTION_OUTPUT_TOKENS = 4_096;

export class ReactAgent {
  private readonly permissionManager: PermissionManager;
  private readonly now: () => string;
  private readonly createSessionId: () => string;
  private readonly checkpointStore: AgentCheckpointWriter | undefined;
  private readonly sessionStore: AgentSessionWriter | undefined;
  private readonly streamStore: AgentStreamStore | undefined;
  private readonly auditLog: AgentAuditLogWriter | undefined;

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
    this.auditLog = dependencies.auditLog;
  }

  async run(options: AgentRunOptions): Promise<AgentRunResult> {
    const runStartedAt = Date.now();
    const session =
      options.initialSession === undefined
        ? createAgentSession({
            id: this.createSessionId(),
            title: titleFromMessage(options.userMessage),
            mode: options.mode ?? 'read',
            ...(options.userId === undefined ? {} : { userId: options.userId }),
            ...(options.knowledgeSnapshot === undefined
              ? {}
              : { knowledgeSnapshot: options.knowledgeSnapshot }),
            now: this.now,
          })
        : cloneSessionForRun(
            options.initialSession,
            options.mode,
            options.knowledgeSnapshot,
            options.userId,
          );
    const pinnedPreferenceMessages = await loadStoredPreferenceMessages(
      session,
      this.sessionStore,
    );
    appendMessage(session, createMessage({ role: 'user', content: options.userMessage }, this.now));
    await this.saveSession(session);

    const usageMode = options.usageMode ?? 'byok';
    const maxIterations = options.maxIterations ?? 25;
    await this.auditLog?.append({
      type: 'run_started',
      timestamp: this.now(),
      sessionId: session.id,
      mode: session.mode,
      usageMode,
      maxIterations,
      ...(options.allowedTools === undefined ? {} : { allowedTools: options.allowedTools }),
    });
    const finishRunAudit = async (
      status: AgentAuditRunStatus,
      iterations: number,
      finalTextPreview?: string,
      errorMessage?: string,
    ) => {
      await this.auditLog?.append({
        type: 'run_finished',
        timestamp: this.now(),
        sessionId: session.id,
        status,
        iterations,
        durationMs: Math.max(0, Date.now() - runStartedAt),
        ...(finalTextPreview === undefined ? {} : { finalTextPreview }),
        ...(errorMessage === undefined ? {} : { errorMessage }),
      });
    };
    const toolExecutions: AgentToolExecutionRecord[] = [];
    const contextCompression: AgentContextCompressionReport[] = [];
    let finalText = '';

    const safety = assessAgentTaskSafety(options.userMessage, options.taskSafety);
    if (safety.blocked) {
      finalText = safety.finalText ?? 'Request blocked by Agent safety policy.';
      appendMessage(session, createMessage({ role: 'assistant', content: finalText }, this.now));
      await this.saveSession(session);
      await finishRunAudit('safety_blocked', 0, finalText, safety.reason);
      return {
        status: 'safety_blocked',
        session,
        finalText,
        iterations: 0,
        toolExecutions: [],
        contextCompression,
      };
    }

    const round = await this.usageTracker.startConversationRound(session.id, usageMode);
    let roundClosed = false;
    const closeRound = async (status: 'success' | 'aborted' | 'failed', errorMessage?: string) => {
      if (roundClosed) return;
      roundClosed = true;
      await this.usageTracker.endConversationRound(round, status, errorMessage);
    };

    const maxConsecutiveToolFailures = options.maxConsecutiveToolFailures ?? 3;
    const maxToolExecutionMs = options.maxToolExecutionMs ?? 60_000;
    const iterationOffset = normalizeNonNegativeInteger(options.initialIteration, 0);
    const maxToolResultChars = normalizePositiveInteger(
      options.maxToolResultChars,
      DEFAULT_MAX_PERSISTED_TOOL_RESULT_CHARS,
    );
    const allowedToolSet = options.allowedTools === undefined ? undefined : new Set(options.allowedTools);
    const modelContext = this.resolveModelContext(
      options.providerId,
      options.model,
    );
    const contextOptions: AgentContextManagerOptions = {
      ...modelContext,
      ...(options.keepRecentMessages === undefined
        ? {}
        : { keepRecentMessages: options.keepRecentMessages }),
      ...(options.maxToolResultChars === undefined
        ? {}
        : { maxToolResultChars: options.maxToolResultChars }),
      pinnedMessages: pinnedPreferenceMessages,
      activeTask: options.userMessage,
    };
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
        const checkpointIteration = iterationOffset + iteration;
        if (options.signal?.aborted || session.aborted) {
          await saveCheckpoint(iterationOffset + iteration - 1, 'aborted');
          await this.saveSession(session);
          await closeRound('aborted');
          await finishRunAudit('aborted', iteration - 1, finalText);
          return { status: 'aborted', session, finalText, iterations: iteration - 1, toolExecutions, contextCompression };
        }

        await saveCheckpoint(checkpointIteration, 'running');
        const llmTools = this.toolRegistry.llmTools(options.allowedTools);
        let context = buildAgentContext(
          session,
          llmTools,
          contextOptions,
        );
        const compressionReportCountBefore = contextCompression.length;
        for (
          let compactionAttempt = 0;
          context.requiresCompaction &&
          compactionAttempt < MAX_AUTO_COMPACTIONS_PER_ITERATION;
          compactionAttempt += 1
        ) {
          const beforeTokens = context.compression.finalTokenEstimate;
          const compacted = await this.compactSessionContext({
            providerId: options.providerId,
            model: options.model,
            session,
            round,
            trigger: 'auto',
            context,
            contextOptions,
            tools: llmTools,
            iteration,
            ...(options.signal === undefined
              ? {}
              : { signal: options.signal }),
          });
          context = compacted.context;
          if (compacted.status === 'skipped') break;
          contextCompression.push(compacted.report);
          const reduction =
            beforeTokens <= 0
              ? 1
              : (beforeTokens - context.compression.finalTokenEstimate) /
                beforeTokens;
          if (reduction < MIN_COMPACTION_REDUCTION_RATIO) break;
        }
        if (contextCompression.length === compressionReportCountBefore) {
          contextCompression.push(context.compression);
        }
        if (context.compression.phase !== 'healthy') {
          await this.auditLog?.append({
            type: 'context_compaction_observed',
            timestamp: this.now(),
            sessionId: session.id,
            iteration,
            compression: context.compression,
          });
        }
        if (
          context.compression.finalTokenEstimate >
          context.compression.availablePromptTokens
        ) {
          throw new Error(
            'The active Agent context still exceeds the model input capacity after compaction.',
          );
        }
        const request = {
          model: options.model,
          messages: context.messages,
          tools: context.tools,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        };
        await this.auditLog?.append({
          type: 'model_call_started',
          timestamp: this.now(),
          sessionId: session.id,
          iteration,
          providerId: options.providerId,
          model: options.model,
          toolCount: context.tools.length,
        });
        const modelStartedAt = Date.now();
        const response = await this.callModel({
          providerId: options.providerId,
          model: options.model,
          request,
          round,
          sessionId: session.id,
        });
        const safeResponseText = sanitizeAgentOutputText(response.text, options.outputSafety);
        const safeToolCalls = sanitizeAgentOutputValue(response.toolCalls, options.outputSafety).value;
        await this.auditLog?.append({
          type: 'model_call_finished',
          timestamp: this.now(),
          sessionId: session.id,
          iteration,
          providerId: options.providerId,
          model: options.model,
          durationMs: Math.max(0, Date.now() - modelStartedAt),
          toolCallCount: response.toolCalls.length,
          textChars: safeResponseText.value.length,
          ...(response.usage === undefined ? {} : { usage: response.usage }),
        });
        addUsage(session, response.usage);

        const assistantText = safeResponseText.blocked ? blockedAgentFinalText(options.outputSafety) : safeResponseText.value;
        appendMessage(session, createMessage({ role: 'assistant', content: assistantText, toolCalls: safeToolCalls }, this.now));
        await this.saveSession(session);
        await saveCheckpoint(checkpointIteration, 'running');

        if (response.toolCalls.length === 0) {
          finalText = safeResponseText.blocked ? blockedAgentFinalText(options.outputSafety) : safeResponseText.value;
          await saveCheckpoint(checkpointIteration, 'done');
          await this.saveSession(session);
          await closeRound('success');
          const status = safeResponseText.blocked ? 'safety_blocked' : 'done';
          await finishRunAudit(status, iteration, finalText);
          return { status, session, finalText, iterations: iteration, toolExecutions, contextCompression };
        }

        for (const toolCall of response.toolCalls) {
          const startedAt = Date.now();
          await this.auditLog?.append({
            type: 'tool_call_started',
            timestamp: this.now(),
            sessionId: session.id,
            iteration,
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            argumentPreview: serializeToolArguments(toolCall.arguments, options.outputSafety),
          });
          if (allowedToolSet !== undefined && !allowedToolSet.has(toolCall.name)) {
            const record = executionRecord(
              toolCall.id,
              toolCall.name,
              'denied',
              startedAt,
              toolCall.arguments,
              'Tool not allowed by run policy.',
              { failure: classifyAgentToolFailure('Tool not allowed by run policy.'), outputSafety: options.outputSafety },
            );
            toolExecutions.push(record);
            await this.auditLog?.append(toolFinishedAuditEvent(session.id, iteration, record, this.now()));
            await saveCheckpoint(checkpointIteration, 'running');
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
            await saveCheckpoint(checkpointIteration, 'done');
            await closeRound('success');
            await finishRunAudit('permission_denied', iteration, finalText);
            return {
              status: 'permission_denied',
              session,
              finalText,
              iterations: iteration,
              toolExecutions,
              contextCompression,
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
              { failure: classifyAgentToolFailure('Tool is not registered.'), outputSafety: options.outputSafety },
            );
            toolExecutions.push(record);
            await this.auditLog?.append(toolFinishedAuditEvent(session.id, iteration, record, this.now()));
            consecutiveToolFailures += 1;
            await saveCheckpoint(checkpointIteration, 'running');
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
            await saveCheckpoint(checkpointIteration, 'running');
            if (consecutiveToolFailures >= maxConsecutiveToolFailures) {
              finalText = failureStopText(consecutiveToolFailures, record.resultPreview);
              await saveCheckpoint(checkpointIteration, 'failed', finalText);
              await closeRound('failed', finalText);
              await finishRunAudit('tool_failed', iteration, finalText, finalText);
              return {
                status: 'tool_failed',
                session,
                finalText,
                iterations: iteration,
                toolExecutions,
                contextCompression,
              };
            }
            continue;
          }

          const effectiveTool =
            tool.resolveRequiredPermission === undefined
              ? tool
              : {
                  ...tool,
                  requiredPermission: tool.resolveRequiredPermission(toolCall.arguments),
                };
          const permission = await this.permissionManager.checkDetailed({
            mode: session.mode,
            tool: effectiveTool,
            toolCall,
            sessionId: session.id,
            sessionTitle: session.title,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          });

          if (permission.decision !== 'allow') {
            const record = executionRecord(
              toolCall.id,
              tool.name,
              'denied',
              startedAt,
              toolCall.arguments,
              `Permission: ${permission.decision}`,
              { failure: classifyAgentToolFailure(`Permission: ${permission.decision}`), outputSafety: options.outputSafety },
            );
            toolExecutions.push(record);
            await this.auditLog?.append(toolFinishedAuditEvent(session.id, iteration, record, this.now()));
            await saveCheckpoint(checkpointIteration, 'running');
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
            await saveCheckpoint(checkpointIteration, 'running');
            if (permission.decision === 'deny') {
              finalText = 'Permission denied.';
              await saveCheckpoint(checkpointIteration, 'done');
              await this.saveSession(session);
              await closeRound('success');
              await finishRunAudit('permission_denied', iteration, finalText);
              return {
                status: 'permission_denied',
                session,
                finalText,
                iterations: iteration,
                toolExecutions,
                contextCompression,
              };
            }
            continue;
          }

          const approval =
            permission.source === 'approval-provider'
              ? ({
                  granted: true,
                  source: permission.source,
                  toolCallId: toolCall.id,
                  toolName: tool.name,
                  approvedAt: permission.approvedAt ?? this.now(),
                  ...(permission.approvalRequestId === undefined ? {} : { requestId: permission.approvalRequestId }),
                  ...(permission.approvedBy === undefined ? {} : { approvedBy: permission.approvedBy }),
                  ...(permission.reason === undefined ? {} : { reason: permission.reason }),
                } satisfies AgentToolApproval)
              : undefined;
          const approvalMetadata = approvalRecord(approval);

          try {
            const context = {
              session,
              ...(options.signal === undefined ? {} : { signal: options.signal }),
              ...(approval === undefined ? {} : { approval }),
            };
            const result = await executeToolWithTimeout(
              tool.name,
              tool.handler,
              toolCall.arguments,
              context,
              maxToolExecutionMs,
            );
            const safeResult = sanitizeAgentOutputValue(result, options.outputSafety);
            if (safeResult.blocked) {
              const preview = blockedAgentToolResultMessage(safeResult.reasons, options.outputSafety);
              const record = executionRecord(toolCall.id, tool.name, 'failed', startedAt, toolCall.arguments, preview, {
                outputSafety: options.outputSafety,
                failure: { failureKind: 'output_safety', retryable: true },
                blocked: true,
                redactionReasons: safeResult.reasons,
                ...(approvalMetadata === undefined ? {} : { approval: approvalMetadata }),
              });
              toolExecutions.push(record);
              await this.auditLog?.append(toolFinishedAuditEvent(session.id, iteration, record, this.now()));
              consecutiveToolFailures += 1;
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
              await saveCheckpoint(checkpointIteration, 'running');
              if (consecutiveToolFailures >= maxConsecutiveToolFailures) {
                finalText = failureStopText(consecutiveToolFailures, record.resultPreview);
                await saveCheckpoint(checkpointIteration, 'failed', finalText);
                await this.saveSession(session);
                await closeRound('failed', finalText);
                await finishRunAudit('tool_failed', iteration, finalText, finalText);
                return {
                  status: 'tool_failed',
                  session,
                  finalText,
                  iterations: iteration,
                  toolExecutions,
                  contextCompression,
                };
              }
              continue;
            }
            const preview = serializeToolResult(safeResult.value, maxToolResultChars);
            const record = executionRecord(toolCall.id, tool.name, 'success', startedAt, toolCall.arguments, preview, {
              outputSafety: options.outputSafety,
              redacted: safeResult.redacted,
              redactionReasons: safeResult.reasons,
              ...(approvalMetadata === undefined ? {} : { approval: approvalMetadata }),
            });
            toolExecutions.push(record);
            await this.auditLog?.append(toolFinishedAuditEvent(session.id, iteration, record, this.now()));
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
            await saveCheckpoint(checkpointIteration, 'running');
          } catch (error) {
            const message = limitSerializedToolResult(error instanceof Error ? error.message : String(error), maxToolResultChars);
            const record = executionRecord(
              toolCall.id,
              tool.name,
              'failed',
              startedAt,
              toolCall.arguments,
              message,
              {
                failure: classifyAgentToolFailure(message),
                outputSafety: options.outputSafety,
                ...(approvalMetadata === undefined ? {} : { approval: approvalMetadata }),
              },
            );
            toolExecutions.push(record);
            await this.auditLog?.append(toolFinishedAuditEvent(session.id, iteration, record, this.now()));
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
            await saveCheckpoint(checkpointIteration, 'running');
            if (consecutiveToolFailures >= maxConsecutiveToolFailures) {
              finalText = failureStopText(consecutiveToolFailures, record.resultPreview);
              await saveCheckpoint(checkpointIteration, 'failed', finalText);
              await this.saveSession(session);
              await closeRound('failed', finalText);
              await finishRunAudit('tool_failed', iteration, finalText, finalText);
              return {
                status: 'tool_failed',
                session,
                finalText,
                iterations: iteration,
                toolExecutions,
                contextCompression,
              };
            }
          }
        }
      }

      finalText = 'Max iterations reached.';
      await saveCheckpoint(iterationOffset + maxIterations, 'done');
      await this.saveSession(session);
      await closeRound('success');
      await finishRunAudit('max_iterations_reached', maxIterations, finalText);
      return {
        status: 'max_iterations_reached',
        session,
        finalText,
        iterations: maxIterations,
        toolExecutions,
        contextCompression,
      };
    } catch (error) {
      const status = options.signal?.aborted || session.aborted ? 'aborted' : 'failed';
      const message = error instanceof Error ? error.message : String(error);
      await saveCheckpoint(iterationOffset + currentIteration, status, message);
      await this.saveSession(session);
      await closeRound(status, message);
      await finishRunAudit(status, currentIteration, finalText, message);
      throw error;
    }
  }

  async compact(
    options: AgentManualContextCompactionOptions,
  ): Promise<AgentContextCompactionResult> {
    const session = cloneSessionForCompaction(options.session);
    const pinnedPreferenceMessages = await loadStoredPreferenceMessages(
      session,
      this.sessionStore,
    );
    const tools = this.toolRegistry.llmTools(options.allowedTools);
    const contextOptions: AgentContextManagerOptions = {
      ...this.resolveModelContext(options.providerId, options.model),
      ...(options.keepRecentMessages === undefined
        ? {}
        : { keepRecentMessages: options.keepRecentMessages }),
      ...(options.maxToolResultChars === undefined
        ? {}
        : { maxToolResultChars: options.maxToolResultChars }),
      pinnedMessages: pinnedPreferenceMessages,
    };
    const before = buildAgentContext(session, tools, contextOptions);
    const round = await this.usageTracker.startConversationRound(
      session.id,
      options.usageMode ?? 'byok',
    );
    try {
      const output = await this.compactSessionContext({
        providerId: options.providerId,
        model: options.model,
        session,
        round,
        trigger: 'manual',
        context: before,
        contextOptions,
        tools,
        ...(options.focus?.trim() ? { focus: options.focus.trim() } : {}),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      await this.usageTracker.endConversationRound(round, 'success');
      return {
        status: output.status,
        session,
        report:
          output.status === 'skipped'
            ? { ...output.report, trigger: 'manual' }
            : output.report,
        ...(output.checkpoint === undefined
          ? {}
          : { checkpoint: output.checkpoint }),
      };
    } catch (error) {
      await this.usageTracker.endConversationRound(
        round,
        'failed',
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  private resolveModelContext(
    providerId: string,
    model: string,
  ): Pick<
    AgentContextManagerOptions,
    'modelContextTokens' | 'maxOutputTokens'
  > {
    const registered =
      this.llmRouter.gateway.registry.find(providerId, model) ??
      this.llmRouter.gateway.registerModel({ providerId, model });
    return {
      modelContextTokens: registered.limits.contextTokens,
      maxOutputTokens: registered.limits.maxOutputTokens,
    };
  }

  private async compactSessionContext(
    input: InternalContextCompactionInput,
  ): Promise<InternalContextCompactionOutput> {
    const plan = createAgentContextCompactionPlan(
      input.session,
      input.contextOptions,
      input.trigger,
      input.focus,
    );
    if (!plan) {
      return {
        status: 'skipped',
        context: input.context,
        report: input.context.compression,
      };
    }

    const startedAt = Date.now();
    let summary = '';
    let method: 'model' | 'deterministic-fallback' = 'model';
    try {
      const configuredOutput = input.contextOptions.maxOutputTokens ?? 4_096;
      const maxTokens = Math.max(
        1,
        Math.min(
          configuredOutput,
          MAX_COMPACTION_OUTPUT_TOKENS,
          Math.max(256, Math.floor(plan.availablePromptTokens * 0.2)),
        ),
      );
      let rollingSummary = plan.previousSummary;
      for (
        let batchIndex = 0;
        batchIndex < plan.sourceBatches.length;
        batchIndex += 1
      ) {
        const sourceMessages = plan.sourceBatches[batchIndex] ?? [];
        const response = await this.llmRouter.chat(
          input.providerId,
          {
            model: input.model,
            messages: buildAgentContextCompactionRequest({
              ...(rollingSummary?.trim()
                ? { previousSummary: rollingSummary.trim() }
                : {}),
              sourceMessages,
              ...(plan.focus === undefined ? {} : { focus: plan.focus }),
              maxToolResultChars: plan.requestMaxToolResultChars,
              maxMessageTokens: plan.requestMaxMessageTokens,
            }),
            maxTokens,
            temperature: 0,
            ...(input.signal === undefined ? {} : { signal: input.signal }),
            metadata: {
              purpose: 'context-compaction',
              trigger: input.trigger,
              batch: `${batchIndex + 1}/${plan.sourceBatches.length}`,
            },
          },
          { round: input.round },
        );
        addUsage(input.session, response.usage);
        if (response.toolCalls.length > 0 || !response.text.trim()) {
          throw new Error(
            'Context compaction model returned no usable summary.',
          );
        }
        rollingSummary = response.text;
      }
      summary = rollingSummary ?? '';
    } catch (error) {
      if (input.signal?.aborted) throw error;
      method = 'deterministic-fallback';
      summary = buildDeterministicContextSummary(plan);
    }

    const checkpoint = createAgentContextCheckpoint({
      session: input.session,
      plan,
      summary,
      method,
      now: this.now(),
    });
    input.session.contextCheckpoint = checkpoint;
    await this.saveSession(input.session);
    const context = buildAgentContext(
      input.session,
      input.tools,
      input.contextOptions,
    );
    const report = compactionAppliedReport({
      before: input.context,
      after: context,
      checkpoint,
    });
    await this.auditLog?.append({
      type: 'context_compaction_applied',
      timestamp: this.now(),
      sessionId: input.session.id,
      ...(input.iteration === undefined
        ? {}
        : { iteration: input.iteration }),
      trigger: input.trigger,
      method,
      durationMs: Math.max(0, Date.now() - startedAt),
      compression: report,
    });
    return {
      status: 'compacted',
      context,
      report,
      checkpoint,
    };
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

type InternalContextCompactionInput = {
  providerId: string;
  model: string;
  session: AgentSession;
  round: RoundContext;
  trigger: 'auto' | 'manual';
  context: AgentContextBuildOutput;
  contextOptions: AgentContextManagerOptions;
  tools: LlmTool[];
  focus?: string;
  iteration?: number;
  signal?: AbortSignal;
};

type InternalContextCompactionOutput = {
  status: 'compacted' | 'skipped';
  context: AgentContextBuildOutput;
  report: AgentContextCompressionReport;
  checkpoint?: AgentSession['contextCheckpoint'];
};

function titleFromMessage(message: string): string {
  const trimmed = message.trim().replace(/\s+/g, ' ');
  return trimmed.length > 24 ? `${trimmed.slice(0, 24)}...` : trimmed || '新会话';
}

function cloneSessionForRun(
  session: AgentSession,
  mode: AgentRunOptions['mode'],
  knowledgeSnapshot: AgentRunOptions['knowledgeSnapshot'],
  userId: AgentRunOptions['userId'],
): AgentSession {
  if (session.userId && userId && session.userId !== userId) {
    throw new Error('Agent session belongs to a different user.');
  }
  return {
    ...session,
    mode: mode ?? session.mode,
    ...(userId === undefined
      ? session.userId === undefined
        ? {}
        : { userId: session.userId }
      : { userId }),
    ...(knowledgeSnapshot === undefined
      ? session.knowledgeSnapshot === undefined
        ? {}
        : { knowledgeSnapshot: structuredClone(session.knowledgeSnapshot) }
      : { knowledgeSnapshot: structuredClone(knowledgeSnapshot) }),
    ...(session.contextCheckpoint === undefined
      ? {}
      : { contextCheckpoint: structuredClone(session.contextCheckpoint) }),
    messages: session.messages.map((message) => ({ ...message })),
    tokenUsage: { ...session.tokenUsage },
    aborted: false,
  };
}

function cloneSessionForCompaction(session: AgentSession): AgentSession {
  return {
    ...session,
    messages: structuredClone(session.messages),
    tokenUsage: { ...session.tokenUsage },
    ...(session.knowledgeSnapshot === undefined
      ? {}
      : { knowledgeSnapshot: structuredClone(session.knowledgeSnapshot) }),
    ...(session.contextCheckpoint === undefined
      ? {}
      : { contextCheckpoint: structuredClone(session.contextCheckpoint) }),
  };
}

async function loadStoredPreferenceMessages(
  session: AgentSession,
  store: AgentSessionWriter | undefined,
): Promise<LlmMessage[]> {
  if (!store?.listPreferences) return [];
  const preferences = await store.listPreferences(
    session.userId ?? DEFAULT_AGENT_USER_ID,
    50,
  );
  if (preferences.length === 0) return [];
  return [
    {
      role: 'system',
      content: [
        PREFERENCE_CONTEXT_PREFIX,
        ...preferences.map(
          (preference) =>
            `- ${preference.value}（置信度 ${preference.confidence.toFixed(2)}）`,
        ),
      ].join('\n'),
    },
  ];
}

function serializeToolResult(result: unknown, maxChars: number): string {
  return limitSerializedToolResult(stringifyToolResult(result), maxChars);
}

function serializeToolArguments(args: Record<string, unknown>, outputSafety?: AgentRunOptions['outputSafety']): string {
  return limitSerializedToolResult(
    stringifyToolResult(sanitizeAgentOutputValue(redactPersistedAgentValue(args), outputSafety).value),
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
  metadata: ExecutionRecordMetadata = {},
): AgentToolExecutionRecord {
  const argumentPreview = serializeToolArguments(args, metadata.outputSafety);
  return {
    toolCallId,
    toolName,
    status,
    durationMs: Math.max(0, Date.now() - startedAt),
    ...(argumentPreview === '{}' ? {} : { argumentPreview }),
    resultPreview,
    ...(metadata.failure === undefined
      ? {}
      : { failureKind: metadata.failure.failureKind, retryable: metadata.failure.retryable }),
    ...(metadata.redacted === true ? { redacted: true } : {}),
    ...(metadata.blocked === true ? { blocked: true } : {}),
    ...(metadata.redactionReasons && metadata.redactionReasons.length > 0
      ? { redactionReasons: metadata.redactionReasons }
      : {}),
    ...(metadata.approval === undefined ? {} : { approval: metadata.approval }),
  };
}

type ExecutionRecordMetadata = {
  failure?: { failureKind: NonNullable<AgentToolExecutionRecord['failureKind']>; retryable: boolean };
  outputSafety?: AgentRunOptions['outputSafety'];
  redacted?: boolean;
  blocked?: boolean;
  redactionReasons?: AgentOutputRedactionReason[];
  approval?: AgentToolApprovalRecord;
};

function approvalRecord(approval: AgentToolApproval | undefined): AgentToolApprovalRecord | undefined {
  if (!approval) return undefined;
  return {
    source: approval.source,
    ...(approval.requestId === undefined ? {} : { requestId: approval.requestId }),
    approvedAt: approval.approvedAt,
    ...(approval.approvedBy === undefined ? {} : { approvedBy: approval.approvedBy }),
    ...(approval.reason === undefined ? {} : { reason: approval.reason }),
  };
}

function toolFinishedAuditEvent(
  sessionId: string,
  iteration: number,
  record: AgentToolExecutionRecord,
  timestamp: string,
) {
  return {
    type: 'tool_call_finished' as const,
    timestamp,
    sessionId,
    iteration,
    toolCallId: record.toolCallId,
    toolName: record.toolName,
    status: record.status,
    durationMs: record.durationMs,
    resultPreview: record.resultPreview,
    ...(record.failureKind === undefined ? {} : { failureKind: record.failureKind }),
    ...(record.retryable === undefined ? {} : { retryable: record.retryable }),
    ...(record.redacted === undefined ? {} : { redacted: record.redacted }),
    ...(record.blocked === undefined ? {} : { blocked: record.blocked }),
    ...(record.redactionReasons === undefined ? {} : { redactionReasons: record.redactionReasons }),
    ...(record.approval === undefined ? {} : { approval: record.approval }),
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

function normalizeNonNegativeInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

function toolTimeoutMessage(toolName: string, timeoutMs: number): string {
  return `工具 ${toolName} 执行超时（${timeoutMs}ms）。`;
}
