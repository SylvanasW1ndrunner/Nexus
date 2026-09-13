import { RETRYABLE_LLM_HTTP_STATUSES } from '../retry-policy.js';
import {
  readLimitedResponseText,
  resolveLlmMaxResponseBytes,
  resolveLlmStreamLimits,
  type LlmStreamLimitOptions,
} from '../stream-safety.js';
import { ModelClientError, type ModelClient, type ModelClientRequest } from '../model-client.js';

export type NdjsonTransportOptions = {
  url: string;
  headers?: Readonly<Record<string, string>>;
  fetch?: (input: string | URL, init?: RequestInit) => Promise<Response>;
  maxResponseBytes?: number;
  streamLimits?: LlmStreamLimitOptions;
};

type NdjsonTransportState = {
  url: string;
  headers: Readonly<Record<string, string>>;
  fetchImpl: (input: string | URL, init?: RequestInit) => Promise<Response>;
  maxResponseBytes: number;
  maxFrameBytes: number;
};

const NDJSON_TRANSPORT_STATE = new WeakMap<NdjsonTransport, NdjsonTransportState>();

/** One streaming NDJSON HTTP attempt; it never retries or changes endpoints. */
export class NdjsonTransport implements ModelClient {
  constructor(options: NdjsonTransportOptions) {
    NDJSON_TRANSPORT_STATE.set(this, {
      url: new URL(options.url).toString(),
      headers: Object.freeze({ ...(options.headers ?? {}) }),
      fetchImpl: options.fetch ?? fetch,
      maxResponseBytes: resolveLlmMaxResponseBytes(options.maxResponseBytes),
      maxFrameBytes: resolveLlmStreamLimits(options.streamLimits).maxSseFrameBytes,
    });
    Object.freeze(this);
  }

  async execute(request: ModelClientRequest) {
    const state = NDJSON_TRANSPORT_STATE.get(this)!;
    let response: Response;
    try {
      response = await state.fetchImpl(state.url, {
        method: 'POST',
        headers: {
          accept: 'application/x-ndjson, application/json',
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
    return {
      kind: 'stream' as const,
      events: ndjsonEvents(response.body, state.maxFrameBytes),
    };
  }
}

async function* ndjsonEvents(
  body: ReadableStream<Uint8Array>,
  maxFrameBytes: number,
): AsyncIterable<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  try {
    while (true) {
      const result = await reader.read();
      buffer += decoder.decode(result.value, { stream: !result.done });
      if (encoder.encode(buffer).byteLength > maxFrameBytes && !buffer.includes('\n')) {
        throw new ModelClientError('TRANSPORT_ERROR', 'Model endpoint returned an oversized NDJSON frame.');
      }
      const lines = buffer.split(/\r?\n/u);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim() === '') continue;
        if (encoder.encode(line).byteLength > maxFrameBytes) {
          throw new ModelClientError('TRANSPORT_ERROR', 'Model endpoint returned an oversized NDJSON frame.');
        }
        yield parseNdjsonLine(line);
      }
      if (result.done) break;
    }
    if (buffer.trim() !== '') {
      if (encoder.encode(buffer).byteLength > maxFrameBytes) {
        throw new ModelClientError('TRANSPORT_ERROR', 'Model endpoint returned an oversized NDJSON frame.');
      }
      yield parseNdjsonLine(buffer);
    }
  } catch (error) {
    if (error instanceof ModelClientError) throw error;
    throw new ModelClientError(
      'STREAM_DISCONNECTED',
      error instanceof Error ? error.message : 'Model stream disconnected.',
      { retryable: true },
    );
  } finally {
    reader.releaseLock();
  }
}

function parseNdjsonLine(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    throw new ModelClientError('TRANSPORT_ERROR', 'Model endpoint returned invalid NDJSON JSON.');
  }
}
