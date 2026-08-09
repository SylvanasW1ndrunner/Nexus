import { RETRYABLE_LLM_HTTP_STATUSES } from '../retry-policy.js';
import {
  readLimitedResponseText,
  readLimitedSseData,
  resolveLlmMaxResponseBytes,
  resolveLlmStreamLimits,
  type LlmStreamLimitOptions,
} from '../stream-safety.js';
import { ModelClientError, type ModelClient, type ModelClientRequest } from '../model-client.js';
import { LlmProviderError } from '../types.js';

export type SseTransportOptions = {
  url: string;
  headers?: Readonly<Record<string, string>>;
  fetch?: (input: string | URL, init?: RequestInit) => Promise<Response>;
  maxResponseBytes?: number;
  streamLimits?: LlmStreamLimitOptions;
};

type SseTransportState = {
  url: string;
  headers: Readonly<Record<string, string>>;
  fetchImpl: (input: string | URL, init?: RequestInit) => Promise<Response>;
  maxResponseBytes: number;
  maxFrameBytes: number;
};

const SSE_TRANSPORT_STATE = new WeakMap<SseTransport, SseTransportState>();

/** One streaming HTTP attempt; it never retries or changes endpoints. */
export class SseTransport implements ModelClient {
  constructor(options: SseTransportOptions) {
    SSE_TRANSPORT_STATE.set(this, {
      url: new URL(options.url).toString(),
      headers: Object.freeze({ ...(options.headers ?? {}) }),
      fetchImpl: options.fetch ?? fetch,
      maxResponseBytes: resolveLlmMaxResponseBytes(options.maxResponseBytes),
      maxFrameBytes: resolveLlmStreamLimits(options.streamLimits).maxSseFrameBytes,
    });
    Object.freeze(this);
  }

  async execute(request: ModelClientRequest) {
    const state = SSE_TRANSPORT_STATE.get(this)!;
    let response: Response;
    try {
      response = await state.fetchImpl(state.url, {
        method: 'POST',
        headers: {
          accept: 'text/event-stream',
          'content-type': 'application/json',
          ...state.headers,
        },
        body: JSON.stringify({ ...(request.wireRequest as Record<string, unknown>), stream: true }),
        signal: request.signal,
      });
    } catch (error) {
      if (request.signal.aborted) throw request.signal.reason;
      throw new ModelClientError(
        'CONNECT_FAILED',
        error instanceof Error ? error.message : 'Model stream connection failed.',
        { retryable: true },
      );
    }
    if (!response.ok) {
      const body = await readLimitedResponseText(response, state.maxResponseBytes);
      const retryAfter = response.headers.get('retry-after') ?? undefined;
      throw new ModelClientError('HTTP_ERROR', `Model endpoint returned HTTP ${response.status}: ${body}`, {
        statusCode: response.status,
        retryable: RETRYABLE_LLM_HTTP_STATUSES.has(response.status),
        ...(retryAfter === undefined ? {} : { retryAfter }),
      });
    }
    if (response.body === null) {
      throw new ModelClientError('STREAM_DISCONNECTED', 'Model endpoint returned an empty stream.', {
        retryable: true,
      });
    }
    return { kind: 'stream' as const, events: jsonEvents(response.body, state.maxFrameBytes) };
  }
}

async function* jsonEvents(
  body: ReadableStream<Uint8Array>,
  maxFrameBytes: number,
): AsyncIterable<unknown> {
  try {
    for await (const data of readLimitedSseData(body, maxFrameBytes)) {
      if (data.trim() === '[DONE]') continue;
      try {
        yield JSON.parse(data) as unknown;
      } catch {
        throw new ModelClientError('TRANSPORT_ERROR', 'Model endpoint returned invalid SSE JSON.');
      }
    }
  } catch (error) {
    if (error instanceof ModelClientError) throw error;
    if (error instanceof LlmProviderError && !error.retryable) {
      throw new ModelClientError('TRANSPORT_ERROR', error.message, { retryable: false });
    }
    throw new ModelClientError(
      'STREAM_DISCONNECTED',
      error instanceof Error ? error.message : 'Model stream disconnected.',
      { retryable: true },
    );
  }
}
