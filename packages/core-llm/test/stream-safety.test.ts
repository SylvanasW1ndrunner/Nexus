/* eslint-disable @typescript-eslint/require-await -- Fetch test doubles implement async contracts. */
import { describe, expect, it } from 'vitest';
import {
  AnthropicProvider,
  LlmProviderError,
  OpenAICompatibleProvider,
  readLimitedSseData,
  type LlmChatStreamEvent,
} from '../src/index.js';

const SMALL_FRAME_LIMITS = {
  maxSseFrameBytes: 128,
  maxTextBytes: 4_096,
  maxToolArgumentsBytes: 4_096,
};
const SMALL_TEXT_LIMITS = {
  maxSseFrameBytes: 1_024,
  maxTextBytes: 128,
  maxToolArgumentsBytes: 4_096,
};
const SMALL_TOOL_LIMITS = {
  maxSseFrameBytes: 1_024,
  maxTextBytes: 4_096,
  maxToolArgumentsBytes: 128,
};

describe('LLM provider stream safety limits', () => {
  it('preserves an upstream SSE error within the typed provider-error contract', async () => {
    const secret = 'sk-ant-test-stream-secret';
    const provider = anthropicProvider(
      [
        anthropicSse({
          type: 'error',
          error: { message: `upstream rejected credential ${secret}` },
        }),
      ],
      secret,
    );

    const error = await captureStreamError(provider.stream(streamRequest()));

    expect(error).toBeInstanceOf(LlmProviderError);
    expect(error).toMatchObject({ code: 'LLM_PROVIDER_ERROR' });
    expect(error?.message).toContain(secret);
  });

  it('rejects an oversized OpenAI-compatible SSE frame', async () => {
    const provider = openAiProvider(
      [openAiSse({ choices: [{ delta: { content: 'x'.repeat(256) } }] }), 'data: [DONE]\n\n'],
      SMALL_FRAME_LIMITS,
    );

    await expectStreamLimit(provider.stream(streamRequest()));
  });

  it('rejects oversized accumulated OpenAI-compatible text', async () => {
    const provider = openAiProvider(
      [
        openAiSse({ choices: [{ delta: { content: 'x'.repeat(80) } }] }),
        openAiSse({ choices: [{ delta: { content: 'y'.repeat(80) } }] }),
        'data: [DONE]\n\n',
      ],
      SMALL_TEXT_LIMITS,
    );

    await expectStreamLimit(provider.stream(streamRequest()));
  });

  it('rejects oversized accumulated OpenAI-compatible tool arguments', async () => {
    const provider = openAiProvider(
      [
        openAiSse({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_1',
                    function: { name: 'query', arguments: 'x'.repeat(80) },
                  },
                ],
              },
            },
          ],
        }),
        openAiSse({
          choices: [
            { delta: { tool_calls: [{ index: 0, function: { arguments: 'y'.repeat(80) } }] } },
          ],
        }),
        'data: [DONE]\n\n',
      ],
      SMALL_TOOL_LIMITS,
    );

    await expectStreamLimit(provider.stream(streamRequest()));
  });

  it('rejects an oversized Anthropic SSE frame', async () => {
    const provider = anthropicProvider(
      [
        anthropicSse({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'x'.repeat(256) },
        }),
      ],
      'test-key',
      SMALL_FRAME_LIMITS,
    );

    await expectStreamLimit(provider.stream(streamRequest()));
  });

  it('rejects oversized accumulated Anthropic text', async () => {
    const provider = anthropicProvider(
      [
        anthropicSse({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'x'.repeat(80) },
        }),
        anthropicSse({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'y'.repeat(80) },
        }),
      ],
      'test-key',
      SMALL_TEXT_LIMITS,
    );

    await expectStreamLimit(provider.stream(streamRequest()));
  });

  it('rejects oversized accumulated Anthropic tool arguments', async () => {
    const provider = anthropicProvider(
      [
        anthropicSse({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'tool_1', name: 'query', input: {} },
        }),
        anthropicSse({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: 'x'.repeat(80) },
        }),
        anthropicSse({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: 'y'.repeat(80) },
        }),
      ],
      'test-key',
      SMALL_TOOL_LIMITS,
    );

    await expectStreamLimit(provider.stream(streamRequest()));
  });

  it('cancels the SSE reader when a frame exceeds the configured limit', async () => {
    let cancelled = false;
    const stream = cancellableSseStream(`data: ${'x'.repeat(256)}`, () => {
      cancelled = true;
    });

    const error = await captureStringStreamError(readLimitedSseData(stream, 64));

    expect(error).toMatchObject({ code: 'LLM_BAD_RESPONSE' });
    expect(cancelled).toBe(true);
  });

  it('cancels the SSE reader when the consumer stops before the body ends', async () => {
    let cancelled = false;
    const stream = cancellableSseStream('data: first\n\n', () => {
      cancelled = true;
    });

    for await (const event of readLimitedSseData(stream, 1_024)) {
      expect(event).toBe('first');
      break;
    }

    expect(cancelled).toBe(true);
  });
});

function openAiProvider(
  chunks: string[],
  streamLimits: { maxSseFrameBytes: number; maxTextBytes: number; maxToolArgumentsBytes: number },
): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    id: 'test',
    name: 'Test Provider',
    apiKey: 'test-key',
    baseUrl: 'https://example.test/v1',
    streamLimits,
    fetch: async () => streamResponse(chunks),
  });
}

function anthropicProvider(
  chunks: string[],
  apiKey: string,
  streamLimits?: { maxSseFrameBytes: number; maxTextBytes: number; maxToolArgumentsBytes: number },
): AnthropicProvider {
  return new AnthropicProvider({
    apiKey,
    ...(streamLimits === undefined ? {} : { streamLimits }),
    fetch: async () => streamResponse(chunks),
  });
}

function streamRequest() {
  return { model: 'test-model', messages: [{ role: 'user' as const, content: 'ping' }] };
}

function openAiSse(body: unknown): string {
  return `data: ${JSON.stringify(body)}\n\n`;
}

function anthropicSse(body: unknown): string {
  return `event: message\ndata: ${JSON.stringify(body)}\n\n`;
}

function streamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

async function expectStreamLimit(iterable: AsyncIterable<LlmChatStreamEvent>): Promise<void> {
  const error = await captureStreamError(iterable);
  expect(error).toBeInstanceOf(LlmProviderError);
  expect(error).toMatchObject({ code: 'LLM_BAD_RESPONSE', retryable: false });
  expect(error?.message).toMatch(/limit/i);
}

async function captureStreamError(
  iterable: AsyncIterable<LlmChatStreamEvent>,
): Promise<Error | undefined> {
  try {
    for await (const event of iterable) {
      // Consume the stream without retaining attacker-controlled output.
      void event;
    }
    return undefined;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

function cancellableSseStream(chunk: string, onCancel: () => void): ReadableStream<Uint8Array> {
  const encoded = new TextEncoder().encode(chunk);
  let delivered = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (delivered) return;
      delivered = true;
      controller.enqueue(encoded);
    },
    cancel() {
      onCancel();
    },
  });
}

async function captureStringStreamError(
  iterable: AsyncIterable<string>,
): Promise<Error | undefined> {
  try {
    for await (const event of iterable) void event;
    return undefined;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}
