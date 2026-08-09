import { RETRYABLE_LLM_HTTP_STATUSES } from '../retry-policy.js';
import { readLimitedResponseText, resolveLlmMaxResponseBytes } from '../stream-safety.js';
import { ModelClientError, type ModelClient, type ModelClientRequest } from '../model-client.js';

export type HttpJsonTransportOptions = {
  url: string;
  headers?: Readonly<Record<string, string>>;
  fetch?: (input: string | URL, init?: RequestInit) => Promise<Response>;
  maxResponseBytes?: number;
};

/** One HTTP attempt. Retry, fallback and deadlines belong to ModelExecutionGateway. */
export class HttpJsonTransport implements ModelClient {
  private readonly fetchImpl: (input: string | URL, init?: RequestInit) => Promise<Response>;
  private readonly maxResponseBytes: number;

  constructor(private readonly options: HttpJsonTransportOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.maxResponseBytes = resolveLlmMaxResponseBytes(options.maxResponseBytes);
  }

  async execute(request: ModelClientRequest) {
    let response: Response;
    try {
      response = await this.fetchImpl(this.options.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(this.options.headers ?? {}) },
        body: JSON.stringify(request.wireRequest),
        signal: request.signal,
      });
    } catch (error) {
      if (request.signal.aborted) throw request.signal.reason;
      throw new ModelClientError(
        'CONNECT_FAILED',
        error instanceof Error ? error.message : 'Model connection failed.',
        { retryable: true },
      );
    }
    const text = await readLimitedResponseText(response, this.maxResponseBytes);
    const body = parseJson(text);
    if (!response.ok) throw httpFailure(response, body);
    if (body === undefined) {
      throw new ModelClientError('TRANSPORT_ERROR', 'Model endpoint returned an empty JSON body.');
    }
    return { kind: 'json' as const, response: body };
  }
}

function parseJson(text: string): unknown {
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ModelClientError('TRANSPORT_ERROR', 'Model endpoint returned invalid JSON.');
  }
}

function httpFailure(response: Response, body: unknown): ModelClientError {
  const status = response.status;
  const retryAfter = response.headers.get('retry-after') ?? undefined;
  const message = errorMessage(body) ?? `Model endpoint returned HTTP ${status}.`;
  return new ModelClientError('HTTP_ERROR', message, {
    statusCode: status,
    retryable: RETRYABLE_LLM_HTTP_STATUSES.has(status),
    ...(retryAfter === undefined ? {} : { retryAfter }),
  });
}

function errorMessage(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const record = body as Record<string, unknown>;
  if (typeof record.message === 'string') return record.message;
  if (typeof record.error === 'string') return record.error;
  if (typeof record.error === 'object' && record.error !== null) {
    const nested = record.error as Record<string, unknown>;
    if (typeof nested.message === 'string') return nested.message;
  }
  return undefined;
}
