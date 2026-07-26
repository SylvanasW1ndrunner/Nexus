import { LlmProviderError } from './types.js';

export type LlmStreamLimits = {
  maxSseFrameBytes: number;
  maxTextBytes: number;
  maxToolArgumentsBytes: number;
  maxToolCalls: number;
};

export type LlmStreamLimitOptions = Partial<LlmStreamLimits>;

export const DEFAULT_LLM_STREAM_LIMITS: Readonly<LlmStreamLimits> = Object.freeze({
  maxSseFrameBytes: 1 * 1_024 * 1_024,
  maxTextBytes: 8 * 1_024 * 1_024,
  maxToolArgumentsBytes: 1 * 1_024 * 1_024,
  maxToolCalls: 128,
});
export const DEFAULT_LLM_MAX_RESPONSE_BYTES = 16 * 1_024 * 1_024;

const MAX_DECODE_SLICE_BYTES = 64 * 1_024;

export function resolveLlmStreamLimits(options: LlmStreamLimitOptions = {}): LlmStreamLimits {
  return {
    maxSseFrameBytes: positiveInteger(
      options.maxSseFrameBytes ?? DEFAULT_LLM_STREAM_LIMITS.maxSseFrameBytes,
      'maxSseFrameBytes',
    ),
    maxTextBytes: positiveInteger(
      options.maxTextBytes ?? DEFAULT_LLM_STREAM_LIMITS.maxTextBytes,
      'maxTextBytes',
    ),
    maxToolArgumentsBytes: positiveInteger(
      options.maxToolArgumentsBytes ?? DEFAULT_LLM_STREAM_LIMITS.maxToolArgumentsBytes,
      'maxToolArgumentsBytes',
    ),
    maxToolCalls: positiveInteger(
      options.maxToolCalls ?? DEFAULT_LLM_STREAM_LIMITS.maxToolCalls,
      'maxToolCalls',
    ),
  };
}

export function resolveLlmMaxResponseBytes(
  maxResponseBytes = DEFAULT_LLM_MAX_RESPONSE_BYTES,
): number {
  return positiveInteger(maxResponseBytes, 'maxResponseBytes');
}

export async function readLimitedResponseText(
  response: Response,
  maxResponseBytes: number,
): Promise<string> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (Number.isFinite(parsedLength) && parsedLength > maxResponseBytes) {
      try {
        await response.body?.cancel();
      } catch {
        // Cancellation is best effort and must not mask the size-limit error.
      }
      throw responseLimitError(maxResponseBytes);
    }
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let body = '';
  let bodyBytes = 0;
  let completed = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bodyBytes += value.byteLength;
      if (bodyBytes > maxResponseBytes) throw responseLimitError(maxResponseBytes);
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    completed = true;
    return body;
  } finally {
    if (!completed) {
      try {
        await reader.cancel();
      } catch {
        // Cancellation is best effort and must not mask the original response error.
      }
    }
    reader.releaseLock();
  }
}

export function addStreamBytes(
  currentBytes: number,
  delta: string,
  limit: number,
  valueName: 'text' | 'tool arguments',
): number {
  const nextBytes = currentBytes + utf8ByteLength(delta);
  if (nextBytes > limit) throw streamLimitError(valueName, limit);
  return nextBytes;
}

export function assertToolCallCapacity(currentCount: number, limit: number): void {
  if (currentCount >= limit) throw streamLimitError('tool call count', limit);
}

export async function* readLimitedSseData(
  stream: ReadableStream<Uint8Array>,
  maxFrameBytes: number,
): AsyncIterable<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let bufferBytes = 0;
  let completed = false;

  const appendAndDrain = function* (decoded: string): Iterable<string> {
    buffer += decoded;
    bufferBytes += utf8ByteLength(decoded);
    const drained = drainSseBuffer(buffer, maxFrameBytes);
    buffer = drained.rest;
    bufferBytes -= drained.consumedBytes;
    if (bufferBytes > maxFrameBytes) throw streamLimitError('SSE frame', maxFrameBytes);
    yield* drained.events;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      for (let offset = 0; offset < value.byteLength; offset += MAX_DECODE_SLICE_BYTES) {
        const slice = value.subarray(offset, offset + MAX_DECODE_SLICE_BYTES);
        yield* appendAndDrain(decoder.decode(slice, { stream: true }));
      }
    }
    yield* appendAndDrain(decoder.decode());
    if (buffer.length > 0) yield* appendAndDrain('\n\n');
    completed = true;
  } finally {
    if (!completed) {
      try {
        await reader.cancel();
      } catch {
        // Cancellation is best effort and must not mask the original stream error.
      }
    }
    reader.releaseLock();
  }
}

function drainSseBuffer(
  input: string,
  maxFrameBytes: number,
): { events: string[]; rest: string; consumedBytes: number } {
  const events: string[] = [];
  let rest = input;
  let consumedBytes = 0;

  while (true) {
    const boundary = /\r?\n\r?\n/.exec(rest);
    if (!boundary || boundary.index === undefined) break;
    const rawEvent = rest.slice(0, boundary.index);
    const consumed = rest.slice(0, boundary.index + boundary[0].length);
    const frameBytes = utf8ByteLength(rawEvent);
    if (frameBytes > maxFrameBytes) throw streamLimitError('SSE frame', maxFrameBytes);
    consumedBytes += utf8ByteLength(consumed);
    rest = rest.slice(consumed.length);

    const dataLines = rawEvent
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => {
        const value = line.slice(5);
        return value.startsWith(' ') ? value.slice(1) : value;
      });
    if (dataLines.length > 0) events.push(dataLines.join('\n'));
  }

  return { events, rest, consumedBytes };
}

function streamLimitError(valueName: string, limit: number): LlmProviderError {
  return new LlmProviderError(
    'LLM_BAD_RESPONSE',
    `LLM stream ${valueName} exceeded the configured byte limit (${limit}).`,
    false,
  );
}

function responseLimitError(limit: number): LlmProviderError {
  return new LlmProviderError(
    'LLM_BAD_RESPONSE',
    `LLM response body exceeded the configured byte limit (${limit}).`,
    false,
  );
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive integer.`);
  return value;
}
