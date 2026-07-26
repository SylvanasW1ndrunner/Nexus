/* eslint-disable @typescript-eslint/require-await -- Fetch test doubles implement async contracts. */
import { describe, expect, it } from 'vitest';
import {
  AnthropicProvider,
  OpenAICompatibleProvider,
  type LlmChatStreamEvent,
} from '../src/index.js';

const MAX_RESPONSE_BYTES = 128;

describe('LLM provider response body safety', () => {
  it('rejects and cancels an oversized OpenAI-compatible non-stream response', async () => {
    const response = delayedClosingJsonResponse(200, {
      choices: [{ message: { content: 'x'.repeat(512) } }],
    });
    const provider = openAiProvider(() => response.value);

    const error = await captureError(
      provider.chat({ model: 'test-model', messages: [{ role: 'user', content: 'ping' }] }),
    );

    expect(error).toMatchObject({ code: 'LLM_BAD_RESPONSE', retryable: false });
    expect(response.wasCancelled()).toBe(true);
  });

  it('rejects and cancels an oversized OpenAI-compatible error response', async () => {
    const response = delayedClosingJsonResponse(500, {
      error: { message: 'x'.repeat(512) },
    });
    const provider = openAiProvider(() => response.value);

    const error = await captureStreamError(
      provider.stream({
        model: 'test-model',
        messages: [{ role: 'user', content: 'ping' }],
      }),
    );

    expect(error).toMatchObject({ code: 'LLM_BAD_RESPONSE', retryable: false });
    expect(response.wasCancelled()).toBe(true);
  });

  it('rejects and cancels an oversized Anthropic non-stream response', async () => {
    const response = delayedClosingJsonResponse(200, {
      content: [{ type: 'text', text: 'x'.repeat(512) }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const provider = anthropicProvider(() => response.value);

    const error = await captureError(
      provider.chat({ model: 'test-model', messages: [{ role: 'user', content: 'ping' }] }),
    );

    expect(error).toMatchObject({ code: 'LLM_BAD_RESPONSE', retryable: false });
    expect(response.wasCancelled()).toBe(true);
  });

  it('rejects and cancels an oversized Anthropic error response', async () => {
    const response = delayedClosingJsonResponse(500, {
      error: { message: 'x'.repeat(512) },
    });
    const provider = anthropicProvider(() => response.value);

    const error = await captureStreamError(
      provider.stream({
        model: 'test-model',
        messages: [{ role: 'user', content: 'ping' }],
      }),
    );

    expect(error).toMatchObject({ code: 'LLM_BAD_RESPONSE', retryable: false });
    expect(response.wasCancelled()).toBe(true);
  });
});

function openAiProvider(fetchResponse: () => Response): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    id: 'test',
    name: 'Test Provider',
    apiKey: 'test-key',
    baseUrl: 'https://example.test/v1',
    maxRetries: 0,
    maxResponseBytes: MAX_RESPONSE_BYTES,
    fetch: async () => fetchResponse(),
  });
}

function anthropicProvider(fetchResponse: () => Response): AnthropicProvider {
  return new AnthropicProvider({
    apiKey: 'test-key',
    maxResponseBytes: MAX_RESPONSE_BYTES,
    fetch: async () => fetchResponse(),
  });
}

function delayedClosingJsonResponse(
  status: number,
  body: unknown,
): { value: Response; wasCancelled: () => boolean } {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  let delivered = false;
  let cancelled = false;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (delivered) return;
      delivered = true;
      controller.enqueue(bytes);
      closeTimer = setTimeout(() => {
        try {
          controller.close();
        } catch {
          // The bounded reader may already have cancelled the stream.
        }
      }, 25);
    },
    cancel() {
      cancelled = true;
      if (closeTimer) clearTimeout(closeTimer);
    },
  });
  return {
    value: new Response(stream, {
      status,
      headers: { 'content-type': 'application/json' },
    }),
    wasCancelled: () => cancelled,
  };
}

async function captureError(promise: Promise<unknown>): Promise<Error | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

async function captureStreamError(
  iterable: AsyncIterable<LlmChatStreamEvent>,
): Promise<Error | undefined> {
  try {
    for await (const event of iterable) void event;
    return undefined;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}
