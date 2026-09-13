import {
  ModelExecutionGateway,
  createModelSession,
  resolveModelProtocolCodec,
  type CanonicalModelRequest,
  type ModelClient,
  type ModelRouteSnapshotInput,
  type ValidatedModelAttempt,
} from '@dbagent/core-llm';

export async function validatedAttemptFixture(
  attemptId = 'attempt-current',
  argumentPadding = 0,
): Promise<ValidatedModelAttempt> {
  const response = {
    id: `response-${attemptId}`,
    model: 'model-current',
    status: 'completed',
    output: [
      { id: 'message-current', type: 'message', role: 'assistant', content: [
        { type: 'output_text', text: 'I will inspect it.' },
      ] },
      { id: 'item-current-a', type: 'function_call', call_id: 'wire-current-a',
        name: 'query_database', arguments: JSON.stringify({
          sql: 'select 1',
          ...(argumentPadding === 0 ? {} : { padding: 'x'.repeat(argumentPadding) }),
        }) },
      { id: 'reasoning-current', type: 'reasoning', summary: [], encrypted_content: 'opaque-current' },
      { id: 'item-current-b', type: 'function_call', call_id: 'wire-current-b',
        name: 'read_result', arguments: '{"resultRef":"result-current"}' },
    ],
    usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
  };
  const client: ModelClient = { execute: () => Promise.resolve({ kind: 'json', response }) };
  const route: ModelRouteSnapshotInput = {
    routeId: 'journal-fixture-route', connectionId: 'connection-current',
    providerId: 'provider-current', modelId: 'model-current', protocol: 'openai-responses',
    codecRevision: 'openai-responses@1',
    capabilities: { toolCalling: 'supported', streaming: 'supported' },
    contextTokens: 16_384, maxInputTokens: 12_288, maxOutputTokens: 4_096,
    metadata: { source: 'test', revision: '1', digest: 'journal-fixture-route' },
    allowedFallbackRouteIds: [],
  };
  const codec = resolveModelProtocolCodec('openai-responses', 'openai-responses@1');
  if (codec === undefined) throw new Error('Missing registered Responses codec');
  const session = createModelSession({ route, generation: {}, codec, client });
  const request: CanonicalModelRequest = {
    model: 'model-current', messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
  };
  return (await new ModelExecutionGateway({ createAttemptId: () => attemptId })
    .executeAttempt(session, request)).attempt;
}

export async function validatedParallelReadAttemptFixture(
  attemptId = 'attempt-parallel-read',
): Promise<ValidatedModelAttempt> {
  const response = {
    id: `response-${attemptId}`,
    model: 'model-current',
    status: 'completed',
    output: [
      { id: `message-${attemptId}`, type: 'message', role: 'assistant', content: [
        { type: 'output_text', text: 'I will run both reads.' },
      ] },
      { id: `item-${attemptId}-a`, type: 'function_call', call_id: `wire-${attemptId}-a`,
        name: 'query_database', arguments: JSON.stringify({ sql: 'slow' }) },
      { id: `item-${attemptId}-b`, type: 'function_call', call_id: `wire-${attemptId}-b`,
        name: 'query_database', arguments: JSON.stringify({ sql: 'fast' }) },
    ],
    usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
  };
  const client: ModelClient = { execute: () => Promise.resolve({ kind: 'json', response }) };
  const route: ModelRouteSnapshotInput = {
    routeId: 'parallel-read-route', connectionId: 'connection-current',
    providerId: 'provider-current', modelId: 'model-current', protocol: 'openai-responses',
    codecRevision: 'openai-responses@1',
    capabilities: { toolCalling: 'supported', streaming: 'supported' },
    contextTokens: 16_384, maxInputTokens: 12_288, maxOutputTokens: 4_096,
    metadata: { source: 'test', revision: '1', digest: 'parallel-read-route' },
    allowedFallbackRouteIds: [],
  };
  const codec = resolveModelProtocolCodec('openai-responses', 'openai-responses@1');
  if (codec === undefined) throw new Error('Missing registered Responses codec');
  const session = createModelSession({ route, generation: {}, codec, client });
  const request: CanonicalModelRequest = {
    model: 'model-current',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'run both reads' }] }],
  };
  return (await new ModelExecutionGateway({ createAttemptId: () => attemptId })
    .executeAttempt(session, request)).attempt;
}

export async function validatedTextAttemptFixture(
  attemptId = 'attempt-final',
  text = 'The requested work is complete.',
): Promise<ValidatedModelAttempt> {
  const response = {
    id: `response-${attemptId}`,
    model: 'model-current',
    status: 'completed',
    output: [{
      id: 'message-final', type: 'message', role: 'assistant',
      content: [{ type: 'output_text', text }],
    }],
    usage: { input_tokens: 4, output_tokens: 6, total_tokens: 10 },
  };
  const client: ModelClient = { execute: () => Promise.resolve({ kind: 'json', response }) };
  const route: ModelRouteSnapshotInput = {
    routeId: 'journal-final-route', connectionId: 'connection-1',
    providerId: 'provider-current', modelId: 'model-1', protocol: 'openai-responses',
    codecRevision: 'openai-responses@1',
    capabilities: { toolCalling: 'supported', streaming: 'supported' },
    contextTokens: 131_072, maxInputTokens: 131_072, maxOutputTokens: 8_192,
    metadata: { source: 'test', revision: '1', digest: 'journal-final-route' },
    allowedFallbackRouteIds: [],
  };
  const codec = resolveModelProtocolCodec('openai-responses', 'openai-responses@1');
  if (codec === undefined) throw new Error('Missing registered Responses codec');
  const session = createModelSession({ route, generation: {}, codec, client });
  return (await new ModelExecutionGateway({ createAttemptId: () => attemptId }).executeAttempt(
    session,
    { model: 'model-1', messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }] },
  )).attempt;
}
