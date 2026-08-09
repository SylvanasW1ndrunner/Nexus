import { parentPort, workerData } from 'node:worker_threads';
import {
  ModelExecutionGateway,
  createModelSession,
  resolveModelProtocolCodec,
} from '../../../core-llm/dist/index.js';
import { SqliteAgentJournal } from '../../dist/index.js';

const gate = new Int32Array(workerData.gate);
parentPort.postMessage({ type: 'ready' });
Atomics.wait(gate, 0, 0);

const response = {
  id: `response-${workerData.attemptId}`,
  model: 'model-current',
  status: 'completed',
  output: [
    { id: 'message-current', type: 'message', role: 'assistant', content: [
      { type: 'output_text', text: 'I will inspect it.' },
    ] },
    { id: 'item-current-a', type: 'function_call', call_id: 'wire-current-a',
      name: 'query_database', arguments: '{"sql":"select 1"}' },
    { id: 'reasoning-current', type: 'reasoning', summary: [], encrypted_content: 'opaque-current' },
    { id: 'item-current-b', type: 'function_call', call_id: 'wire-current-b',
      name: 'read_result', arguments: '{"resultRef":"result-current"}' },
  ],
  usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
};
const client = { execute: () => Promise.resolve({ kind: 'json', response }) };
const route = {
  routeId: 'journal-worker-route', connectionId: 'connection-current',
  providerId: 'provider-current', modelId: 'model-current', protocol: 'openai-responses',
  codecRevision: 'openai-responses@1',
  capabilities: { toolCalling: 'supported', streaming: 'supported' },
  contextTokens: 16_384, maxInputTokens: 12_288, maxOutputTokens: 4_096,
  metadata: { source: 'test', revision: '1', digest: 'journal-worker-route' },
  allowedFallbackRouteIds: [],
};
const codec = resolveModelProtocolCodec('openai-responses', 'openai-responses@1');
const session = createModelSession({ route, generation: {}, codec, client });
const request = {
  model: 'model-current', messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
};
const attempt = (await new ModelExecutionGateway({
  createAttemptId: () => workerData.attemptId,
}).executeAttempt(session, request)).attempt;
const journal = new SqliteAgentJournal({ filePath: workerData.filePath, busyTimeoutMs: 5_000 });
parentPort.postMessage({ type: 'calling' });
const result = await journal.commitValidatedAttempt({ ...workerData.command, attempt });
if (workerData.pauseAfterCommit) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
parentPort.postMessage({ type: 'result', result });
