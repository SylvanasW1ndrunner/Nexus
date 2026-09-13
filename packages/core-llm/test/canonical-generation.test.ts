import { describe, expect, it } from 'vitest';
import {
  ModelExecutionGateway,
  createModelSession,
  type ModelClient,
  type ModelClientRequest,
  type ModelClientResponse,
  type ModelRouteSnapshotInput,
} from '../src/index.js';
import { anthropicMessagesCodec } from '../src/protocol/codecs/anthropic-messages.js';
import { ollamaChatCodec } from '../src/protocol/codecs/ollama-chat.js';
import { openAIChatCodec } from '../src/protocol/codecs/openai-chat.js';
import { openAIResponsesCodec } from '../src/protocol/codecs/openai-responses.js';

describe('canonical generation parameters', () => {
  it('encodes seed and reasoning effort for an OpenAI Chat session that declares both supported', async () => {
    const client = new RecordingClient(openAiChatResponse());
    const session = createModelSession({
      route: route('openai-chat', {
        seed: 'supported',
        reasoningEffort: 'supported',
      }),
      generation: { seed: 17, reasoningEffort: 'high' },
      codec: openAIChatCodec,
      client,
    });

    await new ModelExecutionGateway().executeAttempt(session, request());

    expect(client.requests).toHaveLength(1);
    expect(client.requests[0]?.wireRequest).toEqual({
      model: 'test-model',
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: 'hello' }],
      }],
      seed: 17,
      reasoning_effort: 'high',
    });
  });

  it('encodes reasoning effort for an OpenAI Responses session that declares it supported', async () => {
    const client = new RecordingClient(openAiResponsesResponse());
    const session = createModelSession({
      route: route('openai-responses', { reasoningEffort: 'supported' }),
      generation: { reasoningEffort: 'medium' },
      codec: openAIResponsesCodec,
      client,
    });

    await new ModelExecutionGateway().executeAttempt(session, request());

    expect(client.requests).toHaveLength(1);
    expect(client.requests[0]?.wireRequest).toEqual({
      model: 'test-model',
      input: [{
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'hello' }],
      }],
      reasoning: { effort: 'medium' },
    });
  });

  it('encodes seed in Ollama options when the frozen route declares it supported', async () => {
    const client = new RecordingClient(ollamaResponse());
    const session = createModelSession({
      route: route('ollama-chat', { seed: 'supported' }),
      generation: { seed: 23 },
      codec: ollamaChatCodec,
      client,
    });

    await new ModelExecutionGateway().executeAttempt(session, request());

    expect(client.requests).toHaveLength(1);
    expect(client.requests[0]?.wireRequest).toEqual({
      model: 'test-model',
      stream: false,
      messages: [{ role: 'user', content: 'hello' }],
      options: { seed: 23 },
    });
  });

  it('rejects an unknown OpenAI Responses stop setting before the network client executes', async () => {
    const client = new RecordingClient(openAiResponsesResponse());
    const session = createModelSession({
      route: route('openai-responses', { stop: 'unknown' }),
      generation: { stop: ['END'] },
      codec: openAIResponsesCodec,
      client,
    });

    await expect(new ModelExecutionGateway().executeAttempt(session, request())).rejects.toMatchObject({
      code: 'MODEL_PROTOCOL_FAILED',
    });
    expect(client.requests).toHaveLength(0);
  });

  it.each([
    ['OpenAI Responses seed', 'openai-responses', openAIResponsesCodec, { seed: 'unsupported' }, { seed: 3 }],
    ['Anthropic seed', 'anthropic-messages', anthropicMessagesCodec, { seed: 'unsupported' }, { seed: 3 }],
    ['Anthropic reasoning effort', 'anthropic-messages', anthropicMessagesCodec, { reasoningEffort: 'unsupported' }, { reasoningEffort: 'low' }],
    ['Ollama reasoning effort', 'ollama-chat', ollamaChatCodec, { reasoningEffort: 'unsupported' }, { reasoningEffort: 'low' }],
  ] as const)(
    'rejects %s from frozen capability metadata before the network client executes',
    (_label, protocol, codec, generationParameters, generation) => {
      const client = new RecordingClient(openAiChatResponse());

      expect(() => createModelSession({
        route: route(protocol, generationParameters),
        generation,
        codec,
        client,
      })).toThrowError(/Frozen model route .* does not support generation parameter/);
      expect(client.requests).toHaveLength(0);
    },
  );

  it.each([
    ['OpenAI Responses seed', openAIResponsesCodec, 'openai-responses', { seed: 3 }],
    ['OpenAI Responses stop', openAIResponsesCodec, 'openai-responses', { stop: ['END'] as string[] }],
    ['Anthropic seed', anthropicMessagesCodec, 'anthropic-messages', { seed: 3 }],
    ['Anthropic reasoning effort', anthropicMessagesCodec, 'anthropic-messages', { reasoningEffort: 'low' }],
    ['Ollama reasoning effort', ollamaChatCodec, 'ollama-chat', { reasoningEffort: 'low' }],
  ] as const)(
    'does not silently discard %s in a direct Canonical Codec call',
    (_label, codec, protocol, generation) => {
      expect(() => codec.encode({ ...request(), ...generation }, {
        requestId: 'direct-codec-request',
        target: { connectionId: 'connection-1', model: 'test-model', protocol },
        replay: { mode: 'new' },
      })).toThrowError(/cannot represent generation parameter/);
    },
  );

  it.each([
    ['OpenAI Chat', openAIChatCodec, 'openai-chat', { temperature: 0.25 }, {
      model: 'test-model', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }], temperature: 0.25,
    }],
    ['OpenAI Chat', openAIChatCodec, 'openai-chat', { topP: 0.8 }, {
      model: 'test-model', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }], top_p: 0.8,
    }],
    ['OpenAI Chat', openAIChatCodec, 'openai-chat', { maxOutputTokens: 77 }, {
      model: 'test-model', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }], max_tokens: 77,
    }],
    ['OpenAI Chat', openAIChatCodec, 'openai-chat', { seed: 7 }, {
      model: 'test-model', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }], seed: 7,
    }],
    ['OpenAI Chat', openAIChatCodec, 'openai-chat', { stop: ['END'] as string[] }, {
      model: 'test-model', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }], stop: ['END'],
    }],
    ['OpenAI Chat', openAIChatCodec, 'openai-chat', { reasoningEffort: 'high' }, {
      model: 'test-model', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }], reasoning_effort: 'high',
    }],
    ['OpenAI Responses', openAIResponsesCodec, 'openai-responses', { temperature: 0.25 }, {
      model: 'test-model', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }], temperature: 0.25,
    }],
    ['OpenAI Responses', openAIResponsesCodec, 'openai-responses', { topP: 0.8 }, {
      model: 'test-model', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }], top_p: 0.8,
    }],
    ['OpenAI Responses', openAIResponsesCodec, 'openai-responses', { maxOutputTokens: 77 }, {
      model: 'test-model', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }], max_output_tokens: 77,
    }],
    ['OpenAI Responses', openAIResponsesCodec, 'openai-responses', { reasoningEffort: 'high' }, {
      model: 'test-model', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }], reasoning: { effort: 'high' },
    }],
    ['Anthropic Messages', anthropicMessagesCodec, 'anthropic-messages', { temperature: 0.25 }, {
      model: 'test-model', max_tokens: 4096, messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }], temperature: 0.25,
    }],
    ['Anthropic Messages', anthropicMessagesCodec, 'anthropic-messages', { topP: 0.8 }, {
      model: 'test-model', max_tokens: 4096, messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }], top_p: 0.8,
    }],
    ['Anthropic Messages', anthropicMessagesCodec, 'anthropic-messages', { maxOutputTokens: 77 }, {
      model: 'test-model', max_tokens: 77, messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    }],
    ['Anthropic Messages', anthropicMessagesCodec, 'anthropic-messages', { stop: ['END'] as string[] }, {
      model: 'test-model', max_tokens: 4096, messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }], stop_sequences: ['END'],
    }],
    ['Ollama Chat', ollamaChatCodec, 'ollama-chat', { temperature: 0.25 }, {
      model: 'test-model', stream: false, messages: [{ role: 'user', content: 'hello' }], options: { temperature: 0.25 },
    }],
    ['Ollama Chat', ollamaChatCodec, 'ollama-chat', { topP: 0.8 }, {
      model: 'test-model', stream: false, messages: [{ role: 'user', content: 'hello' }], options: { top_p: 0.8 },
    }],
    ['Ollama Chat', ollamaChatCodec, 'ollama-chat', { maxOutputTokens: 77 }, {
      model: 'test-model', stream: false, messages: [{ role: 'user', content: 'hello' }], options: { num_predict: 77 },
    }],
    ['Ollama Chat', ollamaChatCodec, 'ollama-chat', { seed: 7 }, {
      model: 'test-model', stream: false, messages: [{ role: 'user', content: 'hello' }], options: { seed: 7 },
    }],
    ['Ollama Chat', ollamaChatCodec, 'ollama-chat', { stop: ['END'] as string[] }, {
      model: 'test-model', stream: false, messages: [{ role: 'user', content: 'hello' }], options: { stop: ['END'] },
    }],
  ] as const)(
    'encodes %s generation fields with a complete protocol literal',
    (_name, codec, protocol, generation, expected) => {
      expect(codec.encode({ ...request(), ...generation }, {
        requestId: 'generation-matrix',
        target: { connectionId: 'connection-1', model: 'test-model', protocol },
        replay: { mode: 'new' },
      }).wireRequest).toEqual(expected);
    },
  );
});

class RecordingClient implements ModelClient {
  readonly requests: ModelClientRequest[] = [];

  constructor(private readonly response: unknown) {}

  execute(request: ModelClientRequest): Promise<ModelClientResponse> {
    this.requests.push(request);
    return Promise.resolve({ kind: 'json', response: this.response });
  }
}

function request() {
  return {
    model: 'test-model',
    messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hello' }] }],
  };
}

function route(
  protocol: ModelRouteSnapshotInput['protocol'],
  generationParameters: NonNullable<ModelRouteSnapshotInput['generationParameters']>,
): ModelRouteSnapshotInput {
  const codecRevision = {
    'openai-chat': 'openai-chat@1',
    'openai-responses': 'openai-responses@1',
    'anthropic-messages': 'anthropic-messages@1',
    'ollama-chat': 'ollama-chat@1',
  }[protocol];
  return {
    routeId: `${protocol}-route`,
    connectionId: 'connection-1',
    providerId: `${protocol}-provider`,
    modelId: 'test-model',
    protocol,
    codecRevision,
    capabilities: { chat: 'supported', streaming: 'supported' },
    generationParameters,
    contextTokens: 16_384,
    maxInputTokens: 12_288,
    maxOutputTokens: 4_096,
    metadata: { source: 'test', revision: '1', digest: 'test-digest' },
  };
}

function openAiChatResponse() {
  return {
    id: 'chat-response',
    choices: [{ message: { content: 'done' }, finish_reason: 'stop' }],
  };
}

function openAiResponsesResponse() {
  return {
    id: 'responses-response',
    status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text: 'done' }] }],
  };
}

function ollamaResponse() {
  return {
    done: true,
    done_reason: 'stop',
    message: { content: 'done' },
  };
}
