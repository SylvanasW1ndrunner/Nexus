import { RETRYABLE_LLM_HTTP_STATUSES } from '../retry-policy.js';
import {
  readLimitedResponseText,
  readLimitedSseData,
  resolveLlmMaxResponseBytes,
  resolveLlmStreamLimits,
  type LlmStreamLimitOptions,
} from '../stream-safety.js';
import { ModelClientError, type ModelClient, type ModelClientRequest } from '../model-client.js';

export type SseTransportOptions = {
  url: string;
  headers?: Readonly<Record<string, string>>;
  fetch?: (input: string | URL, init?: RequestInit) => Promise<Response>;
  maxResponseBytes?: number;
  streamLimits?: LlmStreamLimitOptions;
};

/** One streaming HTTP attempt; it never retries or changes endpoints. */
export class SseTransport implements ModelClient {
  private readonly fetchImpl: (input: string | URL, init?: RequestInit) => Promise<Response>;
  private readonly maxResponseBytes: number;
  private readonly maxFrameBytes: number;

  constructor(private readonly options: SseTransportOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.maxResponseBytes = resolveLlmMaxResponseBytes(options.maxResponseBytes);
    this.maxFrameBytes = resolveLlmStreamLimits(options.streamLimits).maxSseFrameBytes;
  }

  async execute(request: ModelClientRequest) {
    let response: Response;
    try {
      response = await this.fetchImpl(this.options.url, {
        method: 'POST',
        headers: {
          accept: 'text/event-stream',
          'content-type': 'application/json',
          ...(this.options.headers ?? {}),
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
      const body = await readLimitedResponseText(response, this.maxResponseBytes);
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
    return { kind: 'stream' as const, events: jsonEvents(response.body, this.maxFrameBytes) };
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
    throw new ModelClientError(
      'STREAM_DISCONNECTED',
      error instanceof Error ? error.message : 'Model stream disconnected.',
      { retryable: true },
    );
  }
}
