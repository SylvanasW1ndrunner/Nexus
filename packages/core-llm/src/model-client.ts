import type { LlmCapabilityStatus, LlmGenerationConfig } from './types.js';
import { validateLlmGenerationConfig } from './generation-config.js';
import type { ModelProtocolCodec } from './protocol/codec.js';
import type { ModelProtocol } from './protocol/content.js';

export type ModelRouteMetadata = {
  source: string;
  revision: string;
  digest: string;
};

export type ModelRouteCompatibility = {
  mode: 'same-connection' | 'compatible-protocol';
  family: string;
};

export type ModelRouteSnapshotInput = {
  routeId: string;
  connectionId: string;
  providerId: string;
  modelId: string;
  protocol: ModelProtocol;
  codecRevision: string;
  capabilities: Record<string, LlmCapabilityStatus>;
  contextTokens: number | null;
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  metadata: ModelRouteMetadata;
  allowedFallbackRouteIds?: readonly string[];
  compatibility?: ModelRouteCompatibility;
};

export type ModelRouteSnapshot = Readonly<{
  routeId: string;
  connectionId: string;
  providerId: string;
  modelId: string;
  protocol: ModelProtocol;
  codecRevision: string;
  capabilities: Readonly<Record<string, LlmCapabilityStatus>>;
  contextTokens: number | null;
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  metadata: Readonly<ModelRouteMetadata>;
  allowedFallbackRouteIds: readonly string[];
  compatibility?: Readonly<ModelRouteCompatibility>;
}>;

export type ValidatedGenerationConfig = Readonly<
  Omit<LlmGenerationConfig, 'stop'> & { stop?: readonly string[] }
>;

export type ModelClientRequest = {
  attemptId: string;
  route: ModelRouteSnapshot;
  wireRequest: unknown;
  signal: AbortSignal;
};

export type ModelClientResponse =
  | { kind: 'json'; response: unknown }
  | { kind: 'stream'; events: AsyncIterable<unknown> };

export interface ModelClient {
  execute(request: ModelClientRequest): Promise<ModelClientResponse>;
}

export type ModelClientErrorCode =
  | 'HTTP_ERROR'
  | 'CONNECT_FAILED'
  | 'STREAM_DISCONNECTED'
  | 'TRANSPORT_ERROR';

export class ModelClientError extends Error {
  readonly retryable: boolean;
  readonly statusCode: number | undefined;
  readonly retryAfterMs: number | undefined;
  readonly retryAfter: string | undefined;

  constructor(
    readonly code: ModelClientErrorCode,
    message: string,
    options: {
      retryable?: boolean;
      statusCode?: number;
      retryAfterMs?: number;
      retryAfter?: string;
    } = {},
  ) {
    super(message);
    this.name = 'ModelClientError';
    this.retryable = options.retryable ?? false;
    this.statusCode = options.statusCode;
    this.retryAfterMs = options.retryAfterMs;
    this.retryAfter = options.retryAfter;
  }
}

export interface ModelSession {
  readonly route: ModelRouteSnapshot;
  readonly generation: ValidatedGenerationConfig;
  readonly codec: ModelProtocolCodec;
  readonly client: ModelClient;
}

export function createModelSession(input: {
  route: ModelRouteSnapshotInput;
  generation: LlmGenerationConfig;
  codec: ModelProtocolCodec;
  client: ModelClient;
}): ModelSession {
  if (input.codec.protocol !== input.route.protocol) {
    throw new Error(
      `ModelSession codec protocol ${input.codec.protocol} does not match route protocol ${input.route.protocol}.`,
    );
  }
  assertRoute(input.route);
  const validated = validateLlmGenerationConfig({
    ...input.generation,
    ...(input.generation.stop === undefined ? {} : { stop: [...input.generation.stop] }),
  });
  const route = freezeRoute(input.route);
  const generation = Object.freeze({
    ...validated,
    ...(validated.stop === undefined ? {} : { stop: Object.freeze([...validated.stop]) }),
  }) as ValidatedGenerationConfig;
  return Object.freeze({ route, generation, codec: input.codec, client: input.client });
}

function freezeRoute(input: ModelRouteSnapshotInput): ModelRouteSnapshot {
  return Object.freeze({
    routeId: input.routeId,
    connectionId: input.connectionId,
    providerId: input.providerId,
    modelId: input.modelId,
    protocol: input.protocol,
    codecRevision: input.codecRevision,
    capabilities: Object.freeze({ ...input.capabilities }),
    contextTokens: input.contextTokens,
    maxInputTokens: input.maxInputTokens,
    maxOutputTokens: input.maxOutputTokens,
    metadata: Object.freeze({ ...input.metadata }),
    allowedFallbackRouteIds: Object.freeze([...(input.allowedFallbackRouteIds ?? [])]),
    ...(input.compatibility === undefined
      ? {}
      : { compatibility: Object.freeze({ ...input.compatibility }) }),
  });
}

function assertRoute(route: ModelRouteSnapshotInput): void {
  for (const [name, value] of [
    ['routeId', route.routeId],
    ['connectionId', route.connectionId],
    ['providerId', route.providerId],
    ['modelId', route.modelId],
    ['codecRevision', route.codecRevision],
    ['metadata.source', route.metadata.source],
    ['metadata.revision', route.metadata.revision],
    ['metadata.digest', route.metadata.digest],
  ] as const) {
    if (!value.trim()) throw new Error(`Model route ${name} must not be empty.`);
  }
  for (const [name, value] of [
    ['contextTokens', route.contextTokens],
    ['maxInputTokens', route.maxInputTokens],
    ['maxOutputTokens', route.maxOutputTokens],
  ] as const) {
    if (value !== null && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new Error(`Model route ${name} must be a positive safe integer or null.`);
    }
  }
}
