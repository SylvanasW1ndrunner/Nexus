import type {
  LlmChatRequest,
  LlmChatResponse,
  LlmMessage,
  LlmRouter,
  LlmTool,
} from '@dbagent/core-llm';
import type { RoundContext, UsageTracker } from '@dbagent/core-usage';
import { stringifyPublicJson } from '@dbagent/shared';
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
import { PermissionManager, requiredPermissionForTool } from './permission-manager.js';
import { assertSameAgentProject } from './project-context.js';
import { addUsage, appendMessage, createAgentSession, createMessage } from './session.js';
import { redactPersistedAgentString, redactPersistedAgentValue } from './redaction.js';
import { AgentRunCoordinator } from './run-coordinator.js';
import type { AgentSessionWriter } from './session-store.js';
import { persistAgentStreamEvents } from './stream-store.js';
import type { AgentStreamStore } from './stream-store.js';
import {
  isAgentTaskPlanComplete,
  renderAgentTaskPlanContext,
  unresolvedAgentTasks,
} from './task-plan.js';
import {
  classifyAgentToolExecutionFailure,
  classifyAgentToolFailure,
} from './tool-failure-classifier.js';
import {
  completionCorrectionMessage,
  verifyAgentCompletion,
} from './completion-verifier.js';
import { createSingleToolCallExecutionGrant } from './tool-execution-authorization.js';
import { isAgentToolResultEnvelope } from './tool-result.js';
import type { ToolRegistry } from './tool-registry.js';
import { AgentUserEventProjector, isUserRelevantAgentEvent } from './user-events.js';
import type {
  AgentSession,
  AgentRunDependencies,
  AgentRunOptions,
  AgentRunStore,
  AgentRunResult,
  AgentToolContext,
  AgentToolApproval,
  AgentToolApprovalRecord,
  AgentToolCompletionEvidence,
  AgentToolExecutionRecord,
  AgentToolHandler,
  AgentToolSource,
  AgentContextCompressionReport,
  AgentContextCompactionResult,
  AgentCompletionVerification,
  AgentManualContextCompactionOptions,
  AgentUserEvent,
  ApprovalProvider,
} from './types.js';

const DEFAULT_MAX_PERSISTED_TOOL_RESULT_CHARS = 12_000;
const DEFAULT_MAX_PERSISTED_TOOL_ARGUMENT_CHARS = 4_000;
const DEFAULT_AGENT_USER_ID = 'local-user';
const PREFERENCE_CONTEXT_PREFIX = '用户长期偏好（自动提炼，可由用户修改或删除）：';
const MAX_AUTO_COMPACTIONS_PER_ITERATION = 2;
const MIN_COMPACTION_REDUCTION_RATIO = 0.05;
const MAX_COMPACTION_OUTPUT_TOKENS = 4_096;
const TOOL_ABORT_SETTLE_TIMEOUT_MS = 500;
export class ReactAgent {
  private readonly permissionManager: PermissionManager;
  private readonly now: () => string;
  private readonly createSessionId: () => string;
  private readonly checkpointStore: AgentCheckpointWriter | undefined;
  private readonly sessionStore: AgentSessionWriter | undefined;
  private readonly streamStore: AgentStreamStore | undefined;
  private readonly auditLog: AgentAuditLogWriter | undefined;
  private readonly runCoordinator: AgentRunCoordinator;
  private readonly runStore: AgentRunStore | undefined;
  private readonly createRunId: () => string;
  private readonly runRecovery: Promise<number> | undefined;

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
    this.createRunId = dependencies.createRunId ?? (() => crypto.randomUUID());
    this.checkpointStore = dependencies.checkpointStore;
    this.sessionStore = dependencies.sessionStore;
    this.streamStore = dependencies.streamStore;
    this.auditLog = dependencies.auditLog;
    this.runStore = dependencies.runStore;
    this.runRecovery = this.runStore?.recoverInterrupted(this.now());
    this.runCoordinator = dependencies.runCoordinator ?? new AgentRunCoordinator();
  }

  steer(sessionId: string, message: string): boolean {
    return this.runCoordinator.steer(sessionId, message, this.now());
  }

  isSessionActive(sessionId: string): boolean {
    return this.runCoordinator.isActive(sessionId);
  }

  async waitForRunRecovery(): Promise<number> {
    return await (this.runRecovery ?? Promise.resolve(0));
  }

  async runSessionOperation<T>(sessionId: string, operation: () => T | Promise<T>): Promise<T> {
    const finish = this.runCoordinator.begin(sessionId, this.now());
    try {
      return await operation();
    } finally {
      finish();
    }
  }

  async run(options: AgentRunOptions): Promise<AgentRunResult> {
    await this.runRecovery;
    const runStartedAt = Date.now();
    const runId = this.createRunId();
    const runCreatedAt = this.now();
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
            ...(options.project === undefined ? {} : { project: options.project }),
            ...(options.activatedSkills === undefined
              ? {}
              : { activeSkills: options.activatedSkills }),
            ...(options.sessionSkills === undefined
              ? {}
              : { sessionSkills: options.sessionSkills }),
            ...(options.subagentDepth === undefined
              ? {}
              : { subagentDepth: options.subagentDepth }),
            now: this.now,
          })
        : cloneSessionForRun(
            options.initialSession,
            options.mode,
            options.knowledgeSnapshot,
            options.userId,
            options.project,
            options.activatedSkills,
            options.subagentDepth,
          );
    const finishActiveRun = this.runCoordinator.begin(session.id, this.now());
    try {
      const userEvents: AgentUserEvent[] = [];
      const eventProjector = new AgentUserEventProjector(options.eventSink, {
        now: this.now,
      });
      const emitUserEvent = async (draft: Parameters<AgentUserEventProjector['emit']>[1]) => {
        const event = await eventProjector.emit(session.id, draft);
        if (isUserRelevantAgentEvent(event)) userEvents.push(event);
      };
      const pinnedPreferenceMessages = await loadStoredPreferenceMessages(
        session,
        this.sessionStore,
      );
      appendMessage(
        session,
        createMessage({ role: 'user', content: options.userMessage }, this.now),
      );
      await emitUserEvent({
        type: 'goal-understood',
        message: '已理解本次请求，正在结合当前数据库与项目上下文处理。',
      });
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
      const transientToolResults = new Map<string, string>();
      const contextCompression: AgentContextCompressionReport[] = [];
      let finalText = '';
      let finalizeCorrectionCount = 0;
      let lastCompletion: AgentCompletionVerification | undefined;

      const round = await this.usageTracker.startConversationRound(session.id, usageMode);
      let roundClosed = false;
      const closeRound = async (
        status: 'success' | 'aborted' | 'failed',
        errorMessage?: string,
      ) => {
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
      const allowedToolSet =
        options.allowedTools === undefined ? undefined : new Set(options.allowedTools);
      const modelContext = this.resolveModelContext(options.providerId, options.model);
      const contextOptions: AgentContextManagerOptions = {
        ...modelContext,
        ...(options.keepRecentMessages === undefined
          ? {}
          : { keepRecentMessages: options.keepRecentMessages }),
        ...(options.maxToolResultChars === undefined
          ? {}
          : { maxToolResultChars: options.maxToolResultChars }),
        pinnedMessages: runtimePinnedMessages(
          pinnedPreferenceMessages,
          session,
          options.projectInstructions,
          options.skillCatalog,
        ),
        activeTask: options.userMessage,
      };
      let currentIteration = 0;
      let consecutiveToolFailures = 0;
      const actionObservations = new Map<string, { observation: string; repeats: number }>();
      const resultMetadata = (status: AgentRunResult['status']) => ({
        events: [...userEvents],
        artifacts: structuredClone(session.artifacts ?? []),
        completion:
          lastCompletion ??
          ({
            verified:
              status === 'done' &&
              (session.taskPlan === undefined || isAgentTaskPlanComplete(session.taskPlan)),
            deliveryReady: status === 'done',
            finalResponseReady: status === 'done' && finalText.trim().length > 0,
            phase: status === 'done' ? 'done' : 'verify',
            unresolvedTaskIds: unresolvedAgentTasks(session.taskPlan).map((task) => task.id),
            missing: status === 'done' ? [] : ['completion was not reached'],
            evidenceKinds: [],
          } satisfies AgentCompletionVerification),
      });
      const saveCheckpoint = async (
        iteration: number,
        status: 'running' | 'done' | 'aborted' | 'failed' | 'max_iterations_reached',
        errorMessage?: string,
      ) => {
        await this.checkpointStore?.save({
          session,
          iteration,
          status: status === 'max_iterations_reached' ? 'failed' : status,
          toolExecutions,
          finalText,
          ...(errorMessage === undefined ? {} : { errorMessage }),
          now: this.now(),
        });
        await this.runStore?.saveRun({
          runId,
          sessionId: session.id,
          status,
          phase: status === 'done' ? 'done' : (lastCompletion?.phase ?? 'act'),
          iteration,
          finalText,
          toolExecutions: toolExecutions.map((execution) => ({
            toolName: execution.toolName,
            status: execution.status,
            ...(execution.completionEvidence === undefined
              ? {}
              : { completionEvidence: structuredClone(execution.completionEvidence) }),
          })),
          ...(lastCompletion === undefined
            ? {}
            : { completion: structuredClone(lastCompletion) }),
          ...(errorMessage === undefined ? {} : { errorMessage }),
          createdAt: runCreatedAt,
          updatedAt: this.now(),
        });
      };

      try {
        for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
          currentIteration = iteration;
          const checkpointIteration = iterationOffset + iteration;
          const steeringMessages = this.runCoordinator.consume(session.id);
          for (const steering of steeringMessages) {
            appendMessage(session, {
              role: 'user',
              content: steering.content,
              createdAt: steering.createdAt,
            });
            await emitUserEvent({
              type: 'goal-understood',
              message: '已收到新的补充要求，正在调整当前计划。',
            });
          }
          if (steeringMessages.length > 0) await this.saveSession(session);
          if (options.signal?.aborted || session.aborted) {
            await saveCheckpoint(iterationOffset + iteration - 1, 'aborted');
            await this.saveSession(session);
            await closeRound('aborted');
            await finishRunAudit('aborted', iteration - 1, finalText);
            return {
              runId,
              status: 'aborted',
              session,
              finalText,
              iterations: iteration - 1,
              toolExecutions,
              ...resultMetadata('aborted'),
              contextCompression,
            };
          }

          await saveCheckpoint(checkpointIteration, 'running');
          contextOptions.pinnedMessages = runtimePinnedMessages(
            pinnedPreferenceMessages,
            session,
            options.projectInstructions,
            options.skillCatalog,
          );
          const visibleNames = visibleToolNames(this.toolRegistry, session, options);
          const llmTools = this.toolRegistry.llmTools(visibleNames);
          const visibleToolSet =
            options.dynamicToolDiscovery === true ? new Set(visibleNames ?? []) : undefined;
          let context = buildAgentContext(
            sessionWithTransientToolResults(session, transientToolResults),
            llmTools,
            contextOptions,
          );
          const compressionReportCountBefore = contextCompression.length;
          for (
            let compactionAttempt = 0;
            context.requiresCompaction && compactionAttempt < MAX_AUTO_COMPACTIONS_PER_ITERATION;
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
              ...(options.signal === undefined ? {} : { signal: options.signal }),
            });
            context = compacted.context;
            if (compacted.status === 'skipped') break;
            contextCompression.push(compacted.report);
            const reduction =
              beforeTokens <= 0
                ? 1
                : (beforeTokens - context.compression.finalTokenEstimate) / beforeTokens;
            if (reduction < MIN_COMPACTION_REDUCTION_RATIO) break;
          }
          if (transientToolResults.size > 0) {
            context = buildAgentContext(
              sessionWithTransientToolResults(session, transientToolResults),
              llmTools,
              contextOptions,
            );
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
          if (context.compression.finalTokenEstimate > context.compression.availablePromptTokens) {
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
          const persistedResponseText = redactPersistedAgentString(response.text);
          const persistedToolCalls = redactPersistedAgentValue(
            response.toolCalls,
          ) as LlmChatResponse['toolCalls'];
          await this.auditLog?.append({
            type: 'model_call_finished',
            timestamp: this.now(),
            sessionId: session.id,
            iteration,
            providerId: options.providerId,
            model: options.model,
            durationMs: Math.max(0, Date.now() - modelStartedAt),
            toolCallCount: response.toolCalls.length,
            textChars: persistedResponseText.length,
            ...(response.usage === undefined ? {} : { usage: response.usage }),
          });
          addUsage(session, response.usage);

          appendMessage(
            session,
            createMessage(
              {
                role: 'assistant',
                content: persistedResponseText,
                toolCalls: persistedToolCalls,
              },
              this.now,
            ),
          );
          await this.saveSession(session);
          await saveCheckpoint(checkpointIteration, 'running');

          if (response.toolCalls.length === 0) {
            finalText = persistedResponseText;
            if (looksLikeUnparsedToolInvocation(finalText)) {
              appendMessage(
                session,
                createMessage(
                  {
                    role: 'system',
                    content:
                      'The previous response contained textual tool-call markup that the provider did not expose as a standard tool call. Do not claim completion and do not repeat tool markup in text. Retry the needed action through the provider tool-calling API, or explain that the configured model/provider cannot call tools.',
                  },
                  this.now,
                ),
              );
              await emitUserEvent({
                type: 'correcting',
                message: '模型返回的工具调用格式未被 Provider 识别，正在改用标准工具调用重试。',
              });
              await this.saveSession(session);
              continue;
            }
            const verification = verifyAgentCompletion({
              ...(session.taskPlan === undefined ? {} : { taskPlan: session.taskPlan }),
              toolExecutions,
              proposedFinalText: finalText,
            });
            lastCompletion = verification;
            if (!verification.verified) {
              appendMessage(
                session,
                createMessage(
                  {
                    role: 'system',
                    content: completionCorrectionMessage(verification),
                  },
                  this.now,
                ),
              );
              await emitUserEvent({
                type: 'correcting',
                message: '验收条件尚未全部满足，正在继续检查和补全。',
              });
              await this.saveSession(session);
              continue;
            }
            if (!verification.finalResponseReady) {
              if (
                finalizeCorrectionCount >= 1 &&
                verification.deliveryReady &&
                verification.evidenceKinds.includes('database-result')
              ) {
                finalText = '查询已完成，结果已单独返回。';
                appendMessage(
                  session,
                  createMessage({ role: 'assistant', content: finalText }, this.now),
                );
              } else {
                finalizeCorrectionCount += 1;
                appendMessage(
                  session,
                  createMessage(
                    {
                      role: 'system',
                      content: completionCorrectionMessage(verification),
                    },
                    this.now,
                  ),
                );
                await emitUserEvent({
                  type: 'correcting',
                  message: '结果已经具备，但答复仍是过程描述，正在收敛为最终交付。',
                });
                await this.saveSession(session);
                continue;
              }
            }
            lastCompletion = {
              ...verification,
              verified: true,
              deliveryReady: true,
              finalResponseReady: true,
              phase: 'done',
              missing: [],
            };
            await emitUserEvent({
              type: 'completed',
              message: '任务已完成并通过当前验收检查。',
            });
            await saveCheckpoint(checkpointIteration, 'done');
            await this.saveSession(session);
            await closeRound('success');
            await finishRunAudit('done', iteration, finalText);
            return {
              runId,
              status: 'done',
              session,
              finalText,
              iterations: iteration,
              toolExecutions,
              ...resultMetadata('done'),
              contextCompression,
            };
          }

          finalizeCorrectionCount = 0;
          for (const toolCall of response.toolCalls) {
            const startedAt = Date.now();
            const tool = this.toolRegistry.get(toolCall.name);
            const planBeforeTool = JSON.stringify(session.taskPlan ?? null);
            const artifactIdsBeforeTool = new Set(
              (session.artifacts ?? []).map((artifact) => artifact.id),
            );
            const actionSignature = stableActionSignature(toolCall.name, toolCall.arguments);
            await emitUserEvent({
              type: toolCall.name.includes('sql') ? 'sql-prepared' : 'exploring',
              message: userToolProgressMessage(toolCall.name),
              ...(typeof toolCall.arguments.sql === 'string'
                ? { sql: toolCall.arguments.sql }
                : {}),
            });
            await this.auditLog?.append({
              type: 'tool_call_started',
              timestamp: this.now(),
              sessionId: session.id,
              iteration,
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              argumentPreview: serializeToolArguments(toolCall.arguments),
            });
            if (allowedToolSet !== undefined && !allowedToolSet.has(toolCall.name)) {
              const record = executionRecord(
                toolCall.id,
                toolCall.name,
                'denied',
                startedAt,
                toolCall.arguments,
                'Tool not allowed by run policy.',
                {
                  failure: classifyAgentToolFailure('Tool not allowed by run policy.'),
                },
              );
              toolExecutions.push(record);
              await this.auditLog?.append(
                toolFinishedAuditEvent(session.id, iteration, record, this.now()),
              );
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
              await emitUserEvent({
                type: 'correcting',
                message: '当前运行策略不允许这项操作，正在寻找无需该工具的替代路径。',
              });
              continue;
            }

            if (visibleToolSet !== undefined && !visibleToolSet.has(toolCall.name)) {
              const message = 'Tool is not active. Discover it with tool_search before use.';
              const record = executionRecord(
                toolCall.id,
                toolCall.name,
                'failed',
                startedAt,
                toolCall.arguments,
                message,
                {
                  failure: classifyAgentToolFailure(message),
                },
              );
              toolExecutions.push(record);
              consecutiveToolFailures += 1;
              await this.auditLog?.append(
                toolFinishedAuditEvent(session.id, iteration, record, this.now()),
              );
              appendMessage(
                session,
                createMessage(
                  {
                    role: 'tool',
                    toolCallId: toolCall.id,
                    toolName: toolCall.name,
                    content: JSON.stringify({ error: message }),
                  },
                  this.now,
                ),
              );
              await emitUserEvent({
                type: 'correcting',
                message: '该扩展工具尚未发现，正在先查询可用能力。',
              });
              await saveCheckpoint(checkpointIteration, 'running');
              await this.saveSession(session);
              continue;
            }

            if (!tool) {
              const record = executionRecord(
                toolCall.id,
                toolCall.name,
                'failed',
                startedAt,
                toolCall.arguments,
                'Tool is not registered.',
                {
                  failure: classifyAgentToolFailure('Tool is not registered.'),
                },
              );
              toolExecutions.push(record);
              await this.auditLog?.append(
                toolFinishedAuditEvent(session.id, iteration, record, this.now()),
              );
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
                appendRecoveryInstruction(
                  session,
                  consecutiveToolFailures,
                  record.resultPreview,
                  this.now,
                );
                consecutiveToolFailures = 0;
                await emitUserEvent({
                  type: 'correcting',
                  message: '连续尝试没有取得进展，正在更换工具或查询方式。',
                });
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
            const requiredPermission = requiredPermissionForTool(effectiveTool);
            const invocation = {
              toolCallId: toolCall.id,
              toolName: tool.name,
              requiredPermission,
            };
            const permission = await this.permissionManager.checkDetailed(
              {
                mode: session.mode,
                tool: effectiveTool,
                toolCall,
                sessionId: session.id,
                sessionTitle: session.title,
                ...(options.signal === undefined ? {} : { signal: options.signal }),
              },
              async () => {
                await emitUserEvent({
                  type: 'approval-required',
                  message: `需要你的许可后才能执行：${tool.name}`,
                  ...(typeof toolCall.arguments.sql === 'string'
                    ? { sql: toolCall.arguments.sql }
                    : {}),
                });
              },
            );

            if (permission.decision !== 'allow') {
              const record = executionRecord(
                toolCall.id,
                tool.name,
                'denied',
                startedAt,
                toolCall.arguments,
                `Permission: ${permission.decision}`,
                {
                  failure: classifyAgentToolFailure(`Permission: ${permission.decision}`),
                },
              );
              toolExecutions.push(record);
              await this.auditLog?.append(
                toolFinishedAuditEvent(session.id, iteration, record, this.now()),
              );
              await saveCheckpoint(checkpointIteration, 'running');
              appendMessage(
                session,
                createMessage(
                  {
                    role: 'tool',
                    toolCallId: toolCall.id,
                    toolName: tool.name,
                    content: JSON.stringify({
                      error: 'Permission denied.',
                      permission: permission.decision,
                    }),
                  },
                  this.now,
                ),
              );
              await this.saveSession(session);
              await saveCheckpoint(checkpointIteration, 'running');
              await emitUserEvent({
                type:
                  permission.source === 'missing-approval-provider'
                    ? 'needs-user-input'
                    : 'correcting',
                message:
                  permission.source === 'missing-approval-provider'
                    ? `需要许可才能执行：${tool.name}`
                    : '该操作未获许可，正在保留现有结果并尝试其他路径。',
              });
              continue;
            }

            const approval =
              permission.source === 'approval-provider'
                ? ({
                    granted: true,
                    source: permission.source,
                    sessionId: session.id,
                    toolCallId: toolCall.id,
                    toolName: tool.name,
                    grantedPermission: requiredPermission,
                    approvedAt: permission.approvedAt ?? this.now(),
                    ...(permission.approvalRequestId === undefined
                      ? {}
                      : { requestId: permission.approvalRequestId }),
                    ...(permission.approvedBy === undefined
                      ? {}
                      : { approvedBy: permission.approvedBy }),
                    ...(permission.reason === undefined ? {} : { reason: permission.reason }),
                  } satisfies AgentToolApproval)
                : undefined;
            const approvalMetadata = approvalRecord(approval);

            try {
              const context = {
                session,
                ...(options.allowedTools === undefined
                  ? {}
                  : { allowedTools: options.allowedTools }),
                ...(options.signal === undefined ? {} : { runSignal: options.signal }),
                ...(options.signal === undefined ? {} : { signal: options.signal }),
                invocation,
                ...(approval === undefined ? {} : { approval }),
                ...(approval === undefined
                  ? {}
                  : {
                      executionGrant: createSingleToolCallExecutionGrant(approval),
                    }),
              };
              const result = await executeToolWithTimeout(
                tool.name,
                tool.handler,
                toolCall.arguments,
                context,
                maxToolExecutionMs,
              );
              const envelope = isAgentToolResultEnvelope(result) ? result : undefined;
              const persistedResult = persistedSuccessfulToolResult(
                tool.source,
                envelope?.durableSummary ?? result,
              );
              const modelResult = persistedSuccessfulToolResult(
                tool.source,
                envelope?.modelProjection ?? result,
              );
              const preview = serializeToolResult(persistedResult, maxToolResultChars);
              if (envelope) {
                transientToolResults.set(
                  toolCall.id,
                  serializeToolResult(modelResult, maxToolResultChars),
                );
              }
              const record = executionRecord(
                toolCall.id,
                tool.name,
                'success',
                startedAt,
                toolCall.arguments,
                preview,
                {
                  ...(approvalMetadata === undefined ? {} : { approval: approvalMetadata }),
                  ...(envelope?.completionEvidence === undefined
                    ? {}
                    : { completionEvidence: envelope.completionEvidence }),
                },
              );
              toolExecutions.push(record);
              await this.auditLog?.append(
                toolFinishedAuditEvent(session.id, iteration, record, this.now()),
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
              const noProgress = observeActionResult(actionObservations, actionSignature, preview);
              if (noProgress) {
                appendMessage(
                  session,
                  createMessage(
                    {
                      role: 'system',
                      content:
                        'No-progress guard: this unchanged action produced the same observation repeatedly. Choose a materially different tool, query, or source before retrying.',
                    },
                    this.now,
                  ),
                );
                await emitUserEvent({
                  type: 'correcting',
                  message: '重复操作没有带来新信息，正在切换探索路径。',
                });
              }
              if (JSON.stringify(session.taskPlan ?? null) !== planBeforeTool) {
                await emitUserEvent({
                  type: 'plan-updated',
                  message: planProgressMessage(session),
                });
              }
              for (const artifact of session.artifacts ?? []) {
                if (artifactIdsBeforeTool.has(artifact.id)) continue;
                await emitUserEvent({
                  type: 'artifact-created',
                  message: `已生成产物：${artifact.path}`,
                  artifact,
                });
              }
              if (isSqlExecutionTool(tool.name)) {
                await emitUserEvent({
                  type: 'sql-executed',
                  message: sqlExecutionProgressMessage(modelResult),
                  ...(typeof toolCall.arguments.sql === 'string'
                    ? { sql: toolCall.arguments.sql }
                    : {}),
                  ...sqlExecutionMetrics(modelResult),
                });
                const successfulSqlCount = toolExecutions.filter(
                  (execution) =>
                    execution.status === 'success' && isSqlExecutionTool(execution.toolName),
                ).length;
                if (successfulSqlCount === 6 || successfulSqlCount === 10) {
                  appendMessage(
                    session,
                    createMessage(
                      {
                        role: 'system',
                        content:
                          successfulSqlCount === 6
                            ? 'Exploration checkpoint: several SQL observations are already available. If they cover the required schema and business rules, stop probing and execute the single final SQL that answers the user.'
                            : 'Exploration checkpoint: do not run another diagnostic probe. Execute the final requested SQL now using established facts, or state the one specific missing fact that prevents completion.',
                      },
                      this.now,
                    ),
                  );
                }
              }
              await this.saveSession(session);
              await saveCheckpoint(checkpointIteration, 'running');
            } catch (error) {
              const message = limitSerializedToolResult(
                redactPersistedAgentString(error instanceof Error ? error.message : String(error)),
                maxToolResultChars,
              );
              const record = executionRecord(
                toolCall.id,
                tool.name,
                'failed',
                startedAt,
                toolCall.arguments,
                message,
                {
                  failure: classifyAgentToolExecutionFailure(tool.name, message),
                  ...(approvalMetadata === undefined ? {} : { approval: approvalMetadata }),
                },
              );
              toolExecutions.push(record);
              await this.auditLog?.append(
                toolFinishedAuditEvent(session.id, iteration, record, this.now()),
              );
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
                appendRecoveryInstruction(
                  session,
                  consecutiveToolFailures,
                  record.resultPreview,
                  this.now,
                );
                consecutiveToolFailures = 0;
                await emitUserEvent({
                  type: 'correcting',
                  message: '连续执行失败，正在根据错误信息更换工具或查询方式。',
                });
              }
            }
          }
        }

        finalText = incompleteRunText(session, toolExecutions);
        appendMessage(session, createMessage({ role: 'assistant', content: finalText }, this.now));
        await emitUserEvent({
          type: 'needs-user-input',
          message: '当前信息或执行路径不足以完成全部验收条件，已说明缺少的内容。',
        });
        const maxIterationsMessage =
          'Agent reached the maximum iteration limit before completion verification succeeded.';
        await saveCheckpoint(
          iterationOffset + maxIterations,
          'max_iterations_reached',
          maxIterationsMessage,
        );
        await this.saveSession(session);
        await closeRound('failed', maxIterationsMessage);
        await finishRunAudit('max_iterations_reached', maxIterations, finalText);
        return {
          runId,
          status: 'max_iterations_reached',
          session,
          finalText,
          iterations: maxIterations,
          toolExecutions,
          ...resultMetadata('max_iterations_reached'),
          contextCompression,
        };
      } catch (error) {
        const status = options.signal?.aborted || session.aborted ? 'aborted' : 'failed';
        const message = redactPersistedAgentString(
          error instanceof Error ? error.message : String(error),
        );
        await saveCheckpoint(iterationOffset + currentIteration, status, message);
        await this.saveSession(session);
        await closeRound(status, message);
        await finishRunAudit(status, currentIteration, finalText, message);
        throw error;
      }
    } finally {
      finishActiveRun();
    }
  }

  async compact(
    options: AgentManualContextCompactionOptions,
  ): Promise<AgentContextCompactionResult> {
    const session = cloneSessionForCompaction(options.session);
    const finishActiveRun = this.runCoordinator.begin(session.id, this.now());
    try {
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
            output.status === 'skipped' ? { ...output.report, trigger: 'manual' } : output.report,
          ...(output.checkpoint === undefined ? {} : { checkpoint: output.checkpoint }),
        };
      } catch (error) {
        await this.usageTracker.endConversationRound(
          round,
          'failed',
          redactPersistedAgentString(error instanceof Error ? error.message : String(error)),
        );
        throw error;
      }
    } finally {
      finishActiveRun();
    }
  }

  private resolveModelContext(
    providerId: string,
    model: string,
  ): Pick<AgentContextManagerOptions, 'modelContextTokens' | 'maxOutputTokens'> {
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
      for (let batchIndex = 0; batchIndex < plan.sourceBatches.length; batchIndex += 1) {
        const sourceMessages = plan.sourceBatches[batchIndex] ?? [];
        const response = await this.llmRouter.chat(
          input.providerId,
          {
            model: input.model,
            messages: buildAgentContextCompactionRequest({
              ...(rollingSummary?.trim() ? { previousSummary: rollingSummary.trim() } : {}),
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
          throw new Error('Context compaction model returned no usable summary.');
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
    const context = buildAgentContext(input.session, input.tools, input.contextOptions);
    const report = compactionAppliedReport({
      before: input.context,
      after: context,
      checkpoint,
    });
    await this.auditLog?.append({
      type: 'context_compaction_applied',
      timestamp: this.now(),
      sessionId: input.session.id,
      ...(input.iteration === undefined ? {} : { iteration: input.iteration }),
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

  private async saveSession(
    session: Parameters<AgentSessionWriter['save']>[0]['session'],
  ): Promise<void> {
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
    for await (const event of persistAgentStreamEvents(
      this.streamStore,
      stream.id,
      events,
      this.now,
    )) {
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
  project: AgentRunOptions['project'],
  activatedSkills: AgentRunOptions['activatedSkills'],
  subagentDepth: AgentRunOptions['subagentDepth'],
): AgentSession {
  if (session.userId && userId && session.userId !== userId) {
    throw new Error('Agent session belongs to a different user.');
  }
  if (project) assertSameAgentProject(session.project, project);
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
    ...(project === undefined
      ? session.project === undefined
        ? {}
        : { project: structuredClone(session.project) }
      : { project: structuredClone(project) }),
    ...mergeActivatedSkills(session.activeSkills, activatedSkills),
    ...(session.sessionSkills === undefined
      ? {}
      : { sessionSkills: structuredClone(session.sessionSkills) }),
    ...(subagentDepth === undefined
      ? session.subagentDepth === undefined
        ? {}
        : { subagentDepth: session.subagentDepth }
      : { subagentDepth }),
    ...(session.contextCheckpoint === undefined
      ? {}
      : { contextCheckpoint: structuredClone(session.contextCheckpoint) }),
    messages: session.messages.map((message) => ({ ...message })),
    tokenUsage: { ...session.tokenUsage },
    aborted: false,
  };
}

function mergeActivatedSkills(
  existing: AgentSession['activeSkills'],
  incoming: AgentRunOptions['activatedSkills'],
): Pick<AgentSession, 'activeSkills'> | Record<string, never> {
  if (!existing && !incoming) return {};
  const merged = new Map(
    (existing ?? []).map((skill) => [`${skill.scope}:${skill.name}`, structuredClone(skill)]),
  );
  for (const skill of incoming ?? []) {
    merged.set(`${skill.scope}:${skill.name}`, structuredClone(skill));
  }
  return { activeSkills: [...merged.values()] };
}

function runtimePinnedMessages(
  preferences: LlmMessage[],
  session: AgentSession,
  projectInstructions?: string,
  skillCatalog: AgentRunOptions['skillCatalog'] = [],
): LlmMessage[] {
  const taskPlan = renderAgentTaskPlanContext(session.taskPlan);
  return [
    {
      role: 'system',
      content: [
        'You are SchemaNaut, an autonomous database and SQL agent.',
        'Use tools to inspect facts instead of guessing. Prefer database-side SQL for aggregation, statistics, cleaning, and anomaly detection; never pull an entire dataset into model context.',
        'Create a task plan only for genuinely multi-step work; a single database question normally needs direct discovery, one final SQL query, and result verification. Verify any plan acceptance criteria with concrete tool evidence before claiming completion.',
        'When a request refers to configured thresholds, rules, dictionaries, or mappings, find and use the corresponding database resources. Never invent configured business values.',
        'For dirty JSON or event streams, validate required fields and formats before casting, use business dictionaries when present, and deduplicate by the stated business key and arrival order.',
        'When the visible tools do not cover a needed capability, use tool_search before calling the discovered tool.',
        'For complex or reusable SQL, discover the project file tools and save a readable script under sql/ when that artifact helps the user.',
        'When an action fails or permission is denied, use the observation to choose another valid path. Do not repeat an unchanged action without new information.',
        'Once the requested final SQL has executed successfully and its result satisfies the goal, stop exploring and answer from that verified result.',
        'Keep user-facing explanations concise. Do not expose internal hashes, retrieval scores, node identifiers, action signatures, or hidden implementation state.',
      ].join('\n'),
    },
    ...(projectInstructions?.trim()
      ? [
          {
            role: 'system' as const,
            content: `Project guidance:\n${projectInstructions.trim()}`,
          },
        ]
      : []),
    ...preferences,
    ...(skillCatalog.length > 0
      ? [
          {
            role: 'system' as const,
            content: [
              'Available Skills (load a Skill only when its guidance is relevant):',
              ...skillCatalog.map(
                (skill) => `- ${skill.name} [${skill.scope}]: ${skill.description}`,
              ),
            ].join('\n'),
          },
        ]
      : []),
    ...(session.activeSkills ?? []).map((skill) => ({
      role: 'system' as const,
      content: [
        `<activated_skill name="${skill.name}" scope="${skill.scope}">`,
        skill.instructions,
        '</activated_skill>',
      ].join('\n'),
    })),
    ...(taskPlan ? [{ role: 'system' as const, content: taskPlan }] : []),
  ];
}

const ALWAYS_VISIBLE_TOOL_NAMES = new Set([
  'task_plan_create',
  'task_update',
  'task_list',
  'tool_search',
  'tool_describe',
  'skill_search',
  'skill_load',
  'skill_resource_read',
  'resource_list',
  'resource_get',
  'knowledge_search',
  'sql_execute',
  'sql_explain',
]);

function visibleToolNames(
  registry: ToolRegistry,
  session: AgentSession,
  options: AgentRunOptions,
): string[] | undefined {
  if (options.dynamicToolDiscovery !== true) return options.allowedTools;
  const allowed = options.allowedTools === undefined ? undefined : new Set(options.allowedTools);
  const active = new Set(session.activeTools ?? []);
  return registry
    .list()
    .map((tool) => tool.name)
    .filter(
      (name) =>
        (allowed === undefined || allowed.has(name)) &&
        (ALWAYS_VISIBLE_TOOL_NAMES.has(name) || active.has(name)),
    );
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

function sessionWithTransientToolResults(
  session: AgentSession,
  transientToolResults: ReadonlyMap<string, string>,
): AgentSession {
  if (transientToolResults.size === 0) return session;
  return {
    ...session,
    messages: session.messages.map((message) => {
      if (message.role !== 'tool') return message;
      const transient = transientToolResults.get(message.toolCallId);
      return transient === undefined ? message : { ...message, content: transient };
    }),
  };
}

async function loadStoredPreferenceMessages(
  session: AgentSession,
  store: AgentSessionWriter | undefined,
): Promise<LlmMessage[]> {
  if (!store?.listPreferences) return [];
  const preferences = await store.listPreferences(session.userId ?? DEFAULT_AGENT_USER_ID, 50);
  if (preferences.length === 0) return [];
  return [
    {
      role: 'system',
      content: [
        PREFERENCE_CONTEXT_PREFIX,
        ...preferences.map(
          (preference) => `- ${preference.value}（置信度 ${preference.confidence.toFixed(2)}）`,
        ),
      ].join('\n'),
    },
  ];
}

function serializeToolResult(result: unknown, maxChars: number): string {
  return limitSerializedToolResult(stringifyToolResult(result), maxChars);
}

function persistedSuccessfulToolResult(
  source: AgentToolSource | undefined,
  result: unknown,
): unknown {
  const redacted = redactPersistedAgentValue(result);
  if (
    source !== 'database' ||
    !result ||
    typeof result !== 'object' ||
    Array.isArray(result) ||
    !redacted ||
    typeof redacted !== 'object' ||
    Array.isArray(redacted)
  ) {
    return redacted;
  }

  const originalRecord = result as Record<string, unknown>;
  const redactedRecord = redacted as Record<string, unknown>;
  for (const businessResultKey of ['rows', 'plan']) {
    if (Object.hasOwn(originalRecord, businessResultKey)) {
      redactedRecord[businessResultKey] = structuredClone(originalRecord[businessResultKey]);
    }
  }
  return redactedRecord;
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
    return stringifyPublicJson(result);
  } catch (error) {
    return JSON.stringify({
      error: 'Tool result could not be serialized.',
      reason: redactPersistedAgentString(error instanceof Error ? error.message : String(error)),
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
  const argumentPreview = serializeToolArguments(args);
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
    ...(metadata.approval === undefined ? {} : { approval: metadata.approval }),
    ...(metadata.completionEvidence === undefined
      ? {}
      : { completionEvidence: metadata.completionEvidence }),
  };
}

type ExecutionRecordMetadata = {
  failure?: {
    failureKind: NonNullable<AgentToolExecutionRecord['failureKind']>;
    retryable: boolean;
  };
  approval?: AgentToolApprovalRecord;
  completionEvidence?: AgentToolCompletionEvidence;
};

function approvalRecord(
  approval: AgentToolApproval | undefined,
): AgentToolApprovalRecord | undefined {
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
    ...(record.approval === undefined ? {} : { approval: record.approval }),
  };
}

function appendRecoveryInstruction(
  session: AgentSession,
  failureCount: number,
  lastError: string,
  now: () => string,
): void {
  appendMessage(
    session,
    createMessage(
      {
        role: 'system',
        content: [
          `Recovery required after ${failureCount} consecutive tool failures.`,
          `Latest observation: ${lastError}`,
          'Do not repeat the same unchanged action. Inspect the error, discover another available tool, simplify the query, or ask the user only when essential information is genuinely missing.',
        ].join('\n'),
      },
      now,
    ),
  );
}

function stableActionSignature(toolName: string, args: Record<string, unknown>): string {
  return `${toolName}:${stableJson(args)}`;
}

function looksLikeUnparsedToolInvocation(value: string): boolean {
  return (
    /<tool_calls?\b[^>]*>[\s\S]*<\/tool_calls?>/i.test(value) ||
    /<tool_call\b[^>]*>[\s\S]*<\/tool_call>/i.test(value) ||
    /<tool_calls?>[\s\S]*<tool_call\b/i.test(value) ||
    /<tool_calls?>[\s\S]*<(?:\|?DSML\|?|｜DSML｜)?invoke\b/i.test(value) ||
    /<(?:\|?DSML\|?|｜DSML｜)invoke\b[\s\S]*<(?:\|?DSML\|?|｜DSML｜)parameter\b/i.test(value)
  );
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function observeActionResult(
  observations: Map<string, { observation: string; repeats: number }>,
  action: string,
  observation: string,
): boolean {
  const previous = observations.get(action);
  const repeats = previous?.observation === observation ? previous.repeats + 1 : 0;
  observations.set(action, { observation, repeats });
  return repeats >= 2;
}

function userToolProgressMessage(toolName: string): string {
  if (toolName.includes('schema') || toolName.includes('knowledge')) {
    return '正在检查相关表结构和业务知识。';
  }
  if (toolName.includes('sql')) return '正在准备或验证 SQL。';
  if (toolName.includes('skill')) return '正在读取适用于当前任务的操作指引。';
  if (toolName.includes('search') || toolName.includes('find')) {
    return '正在查找完成任务所需的信息。';
  }
  if (toolName.includes('subagent')) return '正在并行处理一个独立子任务。';
  return '正在执行下一步并检查结果。';
}

function planProgressMessage(session: AgentSession): string {
  const plan = session.taskPlan;
  if (!plan) return '任务计划已更新。';
  const completed = plan.tasks.filter(
    (task) => task.status === 'completed' || task.status === 'cancelled',
  ).length;
  return `任务计划已更新：${completed}/${plan.tasks.length} 项已完成。`;
}

function isSqlExecutionTool(toolName: string): boolean {
  return /(?:^|_)(?:sql_)?execute$|sql_execute|query_execute/i.test(toolName);
}

function sqlExecutionProgressMessage(result: unknown): string {
  const rowCount = numericResultField(result, 'rowCount');
  const affectedRows = numericResultField(result, 'affectedRows');
  if (affectedRows !== undefined) {
    return `SQL 已执行，影响 ${affectedRows} 行。`;
  }
  if (rowCount !== undefined) return `SQL 已执行，结果共 ${rowCount} 行。`;
  return 'SQL 已执行，正在核对结果。';
}

function sqlExecutionMetrics(result: unknown): {
  metrics?: { rowCount?: number; affectedRows?: number };
} {
  const rowCount = numericResultField(result, 'rowCount');
  const affectedRows = numericResultField(result, 'affectedRows');
  if (rowCount === undefined && affectedRows === undefined) return {};
  return {
    metrics: {
      ...(rowCount === undefined ? {} : { rowCount }),
      ...(affectedRows === undefined ? {} : { affectedRows }),
    },
  };
}

function numericResultField(value: unknown, key: 'rowCount' | 'affectedRows'): number | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'number' && Number.isFinite(field) ? field : undefined;
}

function incompleteRunText(session: AgentSession, executions: AgentToolExecutionRecord[]): string {
  const unresolved = unresolvedAgentTasks(session.taskPlan);
  const latestFailure = [...executions]
    .reverse()
    .find((execution) => execution.status !== 'success');
  return [
    unresolved.length > 0
      ? `仍未完成：${unresolved.map((task) => task.title).join('、')}。`
      : '当前执行轮次已经用完，但还没有得到可验证的完成结果。',
    latestFailure ? `最近的问题：${latestFailure.resultPreview}` : undefined,
    '你可以补充缺失的连接、权限或业务条件后继续当前会话；已有上下文和产物会保留。',
  ]
    .filter((line): line is string => line !== undefined)
    .join('\n');
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
        new Error(
          timedOut
            ? toolTimeoutMessage(toolName, timeoutMs)
            : 'Agent run was aborted during tool execution.',
        ),
      );
    };
    controller.signal.addEventListener('abort', rejectOnAbort, { once: true });
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(toolTimeoutMessage(toolName, timeoutMs)));
    }, timeoutMs);
  });
  const handlerPromise = Promise.resolve().then(() =>
    handler(args, { ...context, signal: controller.signal }),
  );

  try {
    return await Promise.race([handlerPromise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
    parentSignal?.removeEventListener('abort', abortFromParent);
    if (controller.signal.aborted) {
      await waitForToolCleanup(handlerPromise, TOOL_ABORT_SETTLE_TIMEOUT_MS);
    }
  }
}

async function waitForToolCleanup(
  handlerPromise: Promise<unknown>,
  timeoutMs: number,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      handlerPromise.then(
        () => undefined,
        () => undefined,
      ),
      new Promise<void>((resolvePromise) => {
        timeout = setTimeout(resolvePromise, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
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
