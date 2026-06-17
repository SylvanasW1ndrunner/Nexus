import type { LlmRouter } from '@dbagent/core-llm';
import type { UsageTracker } from '@dbagent/core-usage';
import { PermissionManager } from './permission-manager.js';
import { addUsage, appendMessage, createAgentSession, createMessage, toLlmMessages } from './session.js';
import { ToolRegistry } from './tool-registry.js';
import type {
  AgentRunDependencies,
  AgentRunOptions,
  AgentRunResult,
  AgentToolExecutionRecord,
  ApprovalProvider,
} from './types.js';

export class ReactAgent {
  private readonly permissionManager: PermissionManager;
  private readonly now: () => string;
  private readonly createSessionId: () => string;

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
  }

  async run(options: AgentRunOptions): Promise<AgentRunResult> {
    const session = createAgentSession({
      id: this.createSessionId(),
      title: titleFromMessage(options.userMessage),
      mode: options.mode ?? 'ask',
      now: this.now,
    });
    appendMessage(session, createMessage({ role: 'user', content: options.userMessage }, this.now));

    const toolExecutions: AgentToolExecutionRecord[] = [];
    const maxIterations = options.maxIterations ?? 25;
    let finalText = '';

    for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
      if (options.signal?.aborted || session.aborted) {
        return { status: 'aborted', session, finalText, iterations: iteration - 1, toolExecutions };
      }

      const request = {
        model: options.model,
        messages: toLlmMessages(session),
        tools: this.toolRegistry.llmTools(),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      };
      const response = await this.llmRouter.chat(options.providerId, request);
      addUsage(session, response.usage);

      appendMessage(
        session,
        createMessage({ role: 'assistant', content: response.text, toolCalls: response.toolCalls }, this.now),
      );

      if (response.usage?.totalTokens && options.tokenBudget && session.tokenUsage.totalTokens > options.tokenBudget) {
        await this.usageTracker.recordLocalQuery();
        return {
          status: 'max_iterations_reached',
          session,
          finalText: 'Token budget exceeded.',
          iterations: iteration,
          toolExecutions,
        };
      }

      if (response.toolCalls.length === 0) {
        finalText = response.text;
        await this.usageTracker.recordLocalQuery();
        return { status: 'done', session, finalText, iterations: iteration, toolExecutions };
      }

      for (const toolCall of response.toolCalls) {
        const startedAt = Date.now();
        const tool = this.toolRegistry.get(toolCall.name);
        if (!tool) {
          const record = executionRecord(toolCall.id, toolCall.name, 'failed', startedAt, 'Tool is not registered.');
          toolExecutions.push(record);
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
          if (permission === 'deny') {
            await this.usageTracker.recordLocalQuery();
            return {
              status: 'permission_denied',
              session,
              finalText: 'Permission denied.',
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
          const result = await tool.handler(toolCall.arguments, context);
          const preview = serializeToolResult(result);
          toolExecutions.push(executionRecord(toolCall.id, tool.name, 'success', startedAt, preview));
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
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          toolExecutions.push(executionRecord(toolCall.id, tool.name, 'failed', startedAt, message));
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
        }
      }
    }

    await this.usageTracker.recordLocalQuery();
    return {
      status: 'max_iterations_reached',
      session,
      finalText: 'Max iterations reached.',
      iterations: maxIterations,
      toolExecutions,
    };
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
