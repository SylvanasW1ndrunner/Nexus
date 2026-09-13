import { createHash } from 'node:crypto';
import { createToolQuestionWaitRequest, validateToolQuestions, validateToolQuestionBundle, PREPARED_TOOL_INTENT_REVISION, type ToolInvocationContribution, type ToolQuestionBundle } from '@dbagent/core-agent';

/** The same canonical schema is used by interactive and unavailable Host backends. */
export function createAskUserToolContribution(options: { interactive: boolean; handlerRevision?: string }): ToolInvocationContribution {
  const handlerRevision = options.handlerRevision ?? 'ask_user.handler.v1';
  return {
    definition: {
      name: 'ask_user', description: 'Ask one to three questions and durably wait for the user. Each answer may choose one option or use free text.',
      aliases: [], tags: ['interaction'], source: 'runtime', exposure: 'direct',
      dangerLevel: 'safe', readonly: false, access: 'write', recoveryClass: 'idempotent',
      permission: { actions: ['write'] },
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['questions'],
        properties: {
          questions: { type: 'array', minItems: 1, maxItems: 3, items: {
            type: 'object', additionalProperties: false, required: ['id', 'prompt'], properties: {
              id: { type: 'string', minLength: 1, maxLength: 64 }, prompt: { type: 'string', minLength: 1, maxLength: 512 },
              options: { type: 'array', minItems: 2, maxItems: 3, items: { type: 'object', additionalProperties: false, required: ['id', 'label'], properties: {
                id: { type: 'string', minLength: 1, maxLength: 64 }, label: { type: 'string', minLength: 1, maxLength: 64 }, description: { type: 'string', minLength: 1, maxLength: 256 },
              } } },
            },
          } },
          waitTimeoutMs: { type: 'integer', minimum: 1000, maximum: 86_400_000 },
        },
      },
      outputSchema: { type: 'object', required: ['status', 'summary'], additionalProperties: false, properties: {
        status: { enum: ['ok', 'unavailable'], type: 'string' }, summary: { type: 'string' },
        reason: { type: 'string' }, questionId: { type: 'string' }, questionRevision: { type: 'integer' },
        answers: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'object', additionalProperties: false, required: ['id'], properties: {
          id: { type: 'string' }, text: { type: 'string' }, optionId: { type: 'string' },
        } } },
      } },
      limits: { timeoutMs: 30_000, maxInputBytes: 32_768, maxOutputBytes: 16_384, maxArtifactBytes: 65_536, maxDepth: 12, maxRecords: 256 },
      toolRevision: 'ask_user.v1', handlerRevision, intentRevision: PREPARED_TOOL_INTENT_REVISION,
      execution: { concurrency: 'exclusive', timeoutMs: 30_000 },
      failurePolicy: { onUnknown: { failureKind: 'unknown', retryable: false } },
      presentation: { category: 'interaction', preparingMessage: '正在准备用户问题。' },
    },
    runtime: {
      revision: { toolName: 'ask_user', toolRevision: 'ask_user.v1', handlerRevision, intentRevision: PREPARED_TOOL_INTENT_REVISION },
      prepare(input, context) {
        validateToolQuestions(input.questions);
        const timeout = input.waitTimeoutMs;
        if (timeout !== undefined && (typeof timeout !== 'number' || !Number.isSafeInteger(timeout) || timeout < 1000 || timeout > 86_400_000)) throw new TypeError('Invalid question wait timeout.');
        const bundle: ToolQuestionBundle = {
          questionId: `question_${createHash('sha256').update(context.idempotencyKey).digest('hex')}`,
          questionRevision: 1, idempotencyKey: context.idempotencyKey,
          owner: { hostId: context.hostId, projectId: context.projectId, sessionId: context.sessionId, runId: context.runId, turnId: context.turnId, invocationId: context.invocationId },
          questions: structuredClone(input.questions), deadline: timeout === undefined ? null : new Date(Date.now() + timeout).toISOString(),
        };
        return {
          input: { bundle }, toolRevision: context.toolRevision, handlerRevision: context.handlerRevision,
          intentRevision: context.intentRevision, generation: context.generation, targetIdentity: null,
          action: { summary: bundle.questions.map(q => q.prompt).join(' / ') },
          permission: { toolName: 'ask_user', dangerLevel: 'safe', readonly: false, access: 'write', recoveryClass: 'idempotent', actions: ['write'], paths: [], hosts: [], network: false, externalWrite: false, destructive: false, credentials: false, admin: false, unknownRisk: false, resolvedAddresses: [], targets: [{ kind: 'user-input', questionId: bundle.questionId }] },
          access: 'write', recoveryClass: 'idempotent', concurrency: 'exclusive', resourceKeys: [`question:${context.runId}`], limits: context.limits,
        };
      },
      execute(input) {
        if (!options.interactive) return { status: 'unavailable', summary: 'This Host cannot request interactive user input.', reason: 'non_interactive_host' };
        validateToolQuestionBundle(input.bundle);
        return createToolQuestionWaitRequest(input.bundle);
      },
    },
  };
}
