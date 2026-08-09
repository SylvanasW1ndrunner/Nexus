import { createHash } from 'node:crypto';
import type {
  LlmCapabilityStatus,
  LlmGenerationConfig,
  LlmGenerationParameterName,
} from './types.js';
import { validateLlmGenerationConfig } from './generation-config.js';
import type { ModelEncodeContext, ModelProtocolCodec } from './protocol/codec.js';
import type { ModelProtocol } from './protocol/content.js';
import type { ModelProtocolEnvelope } from './protocol/envelope.js';
import {
  resolveExactModelProtocolCodec,
  resolveModelProtocolCodec,
} from './protocol/codec-registry.js';
import {
  attachModelClientBindingCapability,
  ModelClientBindingError,
  modelClientBindingCapabilityForSession,
  requireModelClientBindingPayload,
  type ModelClientBindingCapability,
  type ModelClientBindingMetadata,
} from './model-client-binding.js';

export {
  MODEL_PROTOCOL_CODEC_REVISIONS,
  ModelCodecRegistryError,
  resolveModelProtocolCodec,
} from './protocol/codec-registry.js';
export {
  ModelClientBindingError,
  type ModelClientBindingErrorCode,
  type ModelClientBindingMetadata,
} from './model-client-binding.js';

export type ModelRouteMetadata = {
  source: string;
  revision: string;
  connectionConfigurationRevision?: string;
  credentialRevision?: string;
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
  generationParameters?: Partial<Record<LlmGenerationParameterName, LlmCapabilityStatus>>;
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
  generationParameters: Readonly<
    Partial<Record<LlmGenerationParameterName, LlmCapabilityStatus>>
  >;
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

export type ModelReplayBinding = ModelEncodeContext['replay'];

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
  readonly responseStarted: boolean;

  constructor(
    readonly code: ModelClientErrorCode,
    message: string,
    options: {
      retryable?: boolean;
      statusCode?: number;
      retryAfterMs?: number;
      retryAfter?: string;
      responseStarted?: boolean;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ModelClientError';
    this.retryable = options.retryable ?? false;
    this.statusCode = options.statusCode;
    this.retryAfterMs = options.retryAfterMs;
    this.retryAfter = options.retryAfter;
    this.responseStarted = options.responseStarted ?? false;
  }
}

export interface ModelSession {
  readonly route: ModelRouteSnapshot;
  readonly generation: ValidatedGenerationConfig;
  readonly replay: ModelReplayBinding;
  readonly bindingDigest: string;
  /** Private execution handle. It is intentionally non-enumerable. */
  readonly codec: ModelProtocolCodec;
  /** Private execution handle. It is intentionally non-enumerable. */
  readonly client: ModelClient;
}

export interface ModelSessionBundle {
  readonly primary: ModelSession;
  readonly fallbacks: readonly ModelSession[];
  readonly policy: Readonly<ModelFallbackPolicy>;
  readonly bindingDigest: string;
}

export type ModelFallbackPolicy = {
  allowCrossConnection: boolean;
  allowCrossModel: boolean;
};

const SESSION_PRIVATE = new WeakMap<
  ModelSession,
  { codec: ModelProtocolCodec; client: ModelClient }
>();
const AUTHENTIC_SESSIONS = new WeakSet<ModelSession>();
const AUTHENTIC_BUNDLES = new WeakSet<ModelSessionBundle>();

export function createModelSession(input: {
  route: ModelRouteSnapshotInput;
  generation: LlmGenerationConfig;
  codec: ModelProtocolCodec;
  client: ModelClient;
  replay?: ModelReplayBinding;
}): ModelSession {
  if (input.codec.protocol !== input.route.protocol) {
    throw new Error(
      `ModelSession codec protocol ${input.codec.protocol} does not match route protocol ${input.route.protocol}.`,
    );
  }
  const codec = resolveExactModelProtocolCodec(input.codec);
  if (
    input.route.codecRevision !== codec.revision ||
    input.codec.revision !== codec.revision
  ) {
    throw new Error(
      `ModelSession codec revision ${input.route.codecRevision} does not match registered codec revision ${codec.revision}.`,
    );
  }
  if (codec.protocol === 'legacy-normalized' && input.replay?.mode !== undefined && input.replay.mode !== 'new') {
    throw new Error('The legacy-normalized edge does not support replay.');
  }
  assertRoute(input.route);
  const validated = validateSessionGeneration(input.generation, input.route);
  const route = freezeRoute(input.route);
  const generation = Object.freeze({
    ...validated,
    ...(validated.stop === undefined ? {} : { stop: Object.freeze([...validated.stop]) }),
  }) as ValidatedGenerationConfig;
  const replay = freezeReplay(input.replay ?? { mode: 'new' });
  const bindingDigest = digest({
    routeDigest: route.metadata.digest,
    codecRevision: route.codecRevision,
    generation,
    replay,
  });
  const session = {
    route,
    generation,
    replay,
    bindingDigest,
  } as ModelSession;
  Object.defineProperties(session, {
    codec: { enumerable: false, get: () => SESSION_PRIVATE.get(session)!.codec },
    client: { enumerable: false, get: () => SESSION_PRIVATE.get(session)!.client },
  });
  SESSION_PRIVATE.set(session, { codec, client: input.client });
  AUTHENTIC_SESSIONS.add(session);
  return Object.freeze(session);
}

export function createModelSessionBundle(input: {
  primary: ModelSession;
  fallbacks?: readonly ModelSession[];
  policy?: Partial<ModelFallbackPolicy>;
}): ModelSessionBundle {
  for (const session of [input.primary, ...(input.fallbacks ?? [])]) {
    if (!isAuthenticModelSession(session)) {
      throw new Error('Model Session bundles require factory-bound or rehydrated Sessions.');
    }
  }
  const fallbacks = [...(input.fallbacks ?? [])];
  const policy = Object.freeze({
    allowCrossConnection: input.policy?.allowCrossConnection ?? false,
    allowCrossModel: input.policy?.allowCrossModel ?? false,
  });
  const routeIds = new Set<string>();
  for (const session of [input.primary, ...fallbacks]) {
    if (routeIds.has(session.route.routeId)) {
      throw new Error(`Model Session bundle repeats route ${session.route.routeId}.`);
    }
    routeIds.add(session.route.routeId);
  }
  for (const fallback of fallbacks) assertBundleFallback(input.primary, fallback, policy);
  const bundle = Object.freeze({
    primary: input.primary,
    fallbacks: Object.freeze(fallbacks),
    policy,
    bindingDigest: digest({
      primary: input.primary.bindingDigest,
      fallbacks: fallbacks.map((session) => session.bindingDigest),
      policy,
    }),
  });
  AUTHENTIC_BUNDLES.add(bundle);
  return bundle;
}

export function isAuthenticModelSessionBundle(value: unknown): value is ModelSessionBundle {
  return typeof value === 'object' && value !== null && AUTHENTIC_BUNDLES.has(value as ModelSessionBundle);
}

export function isAuthenticModelSession(value: unknown): value is ModelSession {
  return typeof value === 'object' && value !== null && AUTHENTIC_SESSIONS.has(value as ModelSession);
}

function requireModelClientBindingCapability(
  session: ModelSession,
): ModelClientBindingCapability {
  const capability = modelClientBindingCapabilityForSession(session);
  if (capability === undefined) {
    throw new ModelClientBindingError(
      'MODEL_CLIENT_BINDING_REQUIRED',
      'The Model Session has no authenticated client binding capability.',
    );
  }
  return capability;
}

export type PersistedModelSessionDescriptor = Readonly<{
  route: ModelRouteSnapshotInput;
  generation: LlmGenerationConfig;
  replay: ModelReplayBinding;
  clientBinding: ModelClientBindingMetadata;
  bindingDigest: string;
}>;

export function describeModelSession(session: ModelSession): PersistedModelSessionDescriptor {
  if (!isAuthenticModelSession(session)) {
    throw new Error('Only an authentic Model Session can be persisted.');
  }
  if (session.route.protocol === 'legacy-normalized') {
    throw new ModelClientBindingError(
      'MODEL_SESSION_NOT_PERSISTABLE',
      'legacy-normalized Sessions cannot be persisted or rehydrated.',
    );
  }
  const capability = requireModelClientBindingCapability(session);
  const payload = requireModelClientBindingPayload(capability);
  return Object.freeze({
    route: routeDescriptor(session.route),
    generation: generationDescriptor(session.generation),
    replay: freezeReplay(session.replay),
    clientBinding: Object.freeze({
      connectionResolutionRevision: payload.connectionResolutionRevision,
      connectionConfigurationRevision: payload.connectionConfigurationRevision,
      credentialRevision: payload.credentialRevision,
    }),
    bindingDigest: session.bindingDigest,
  });
}

export function rehydrateModelSession(input: {
  descriptor: PersistedModelSessionDescriptor;
  expectedRouteDigest: string;
  expectedSessionDigest: string;
  expectedCodecRevision: string;
  bindingSession?: ModelSession;
}): ModelSession {
  const { descriptor } = input;
  const clientBinding = validatePersistedClientBinding(descriptor);
  const capability = input.bindingSession === undefined
    ? undefined
    : modelClientBindingCapabilityForSession(input.bindingSession);
  if (capability === undefined) {
    throw new ModelClientBindingError(
      'MODEL_CLIENT_BINDING_REQUIRED',
      'A trusted connection-bound Model Session is required for rehydration.',
    );
  }
  const payload = requireModelClientBindingPayload(capability);
  if (
    descriptor.route.metadata.digest !== input.expectedRouteDigest ||
    descriptor.bindingDigest !== input.expectedSessionDigest ||
    descriptor.route.codecRevision !== input.expectedCodecRevision ||
    payload.routeDigest !== descriptor.route.metadata.digest ||
    payload.connectionId !== descriptor.route.connectionId ||
    payload.providerId !== descriptor.route.providerId ||
    payload.modelId !== descriptor.route.modelId ||
    payload.protocol !== descriptor.route.protocol ||
    payload.codecRevision !== descriptor.route.codecRevision ||
    payload.connectionResolutionRevision !== descriptor.route.metadata.revision ||
    payload.connectionConfigurationRevision !==
      descriptor.route.metadata.connectionConfigurationRevision ||
    payload.credentialRevision !== descriptor.route.metadata.credentialRevision ||
    payload.connectionResolutionRevision !== clientBinding.connectionResolutionRevision ||
    payload.connectionConfigurationRevision !==
      clientBinding.connectionConfigurationRevision ||
    payload.credentialRevision !== clientBinding.credentialRevision
  ) {
    throw new ModelClientBindingError(
      'MODEL_CLIENT_BINDING_MISMATCH',
      'Persisted Model Session and authenticated client binding do not match.',
    );
  }
  const codec = resolveModelProtocolCodec(
    descriptor.route.protocol,
    input.expectedCodecRevision,
  );
  const session = createModelSession({
    route: descriptor.route,
    generation: descriptor.generation,
    replay: descriptor.replay,
    codec,
    client: payload.client,
  });
  if (
    session.route.metadata.digest !== input.expectedRouteDigest ||
    session.bindingDigest !== input.expectedSessionDigest
  ) {
    throw new ModelClientBindingError(
      'MODEL_CLIENT_BINDING_MISMATCH',
      'Persisted Model Session failed digest verification during rehydration.',
    );
  }
  attachModelClientBindingCapability(session, capability);
  return session;
}

export type PersistedModelSessionBundleDescriptor = Readonly<{
  primary: PersistedModelSessionDescriptor;
  fallbacks: readonly PersistedModelSessionDescriptor[];
  policy: Readonly<ModelFallbackPolicy>;
  bindingDigest: string;
}>;

export type ModelSessionRehydrationBinding = Readonly<{
  expectedRouteDigest: string;
  expectedSessionDigest: string;
  expectedCodecRevision: string;
  bindingSession?: ModelSession;
}>;

export function describeModelSessionBundle(
  bundle: ModelSessionBundle,
): PersistedModelSessionBundleDescriptor {
  if (!isAuthenticModelSessionBundle(bundle)) {
    throw new Error('Only an authentic Model Session bundle can be persisted.');
  }
  return Object.freeze({
    primary: describeModelSession(bundle.primary),
    fallbacks: Object.freeze(bundle.fallbacks.map(describeModelSession)),
    policy: Object.freeze({ ...bundle.policy }),
    bindingDigest: bundle.bindingDigest,
  });
}

export function rehydrateModelSessionBundle(input: {
  descriptor: PersistedModelSessionBundleDescriptor;
  expectedBundleDigest: string;
  bindings: Readonly<Record<string, ModelSessionRehydrationBinding>>;
}): ModelSessionBundle {
  if (input.descriptor.bindingDigest !== input.expectedBundleDigest) {
    throw new Error('Persisted Model Session bundle digest does not match expectations.');
  }
  const bind = (descriptor: PersistedModelSessionDescriptor): ModelSession => {
    const binding = input.bindings[descriptor.route.routeId];
    if (binding === undefined) {
      throw new ModelClientBindingError(
        'MODEL_CLIENT_BINDING_REQUIRED',
        `No authenticated client binding capability was supplied for route ${descriptor.route.routeId}.`,
      );
    }
    return rehydrateModelSession({ descriptor, ...binding });
  };
  const bundle = createModelSessionBundle({
    primary: bind(input.descriptor.primary),
    fallbacks: input.descriptor.fallbacks.map(bind),
    policy: input.descriptor.policy,
  });
  if (bundle.bindingDigest !== input.expectedBundleDigest) {
    throw new Error('Persisted Model Session bundle failed digest verification during rehydration.');
  }
  return bundle;
}

function assertBundleFallback(
  primary: ModelSession,
  fallback: ModelSession,
  policy: Readonly<ModelFallbackPolicy>,
): void {
  const declared = primary.route.allowedFallbackRouteIds.includes(fallback.route.routeId);
  const primaryCompatibility = primary.route.compatibility;
  const fallbackCompatibility = fallback.route.compatibility;
  const compatible =
    (policy.allowCrossConnection || primary.route.connectionId === fallback.route.connectionId) &&
    (policy.allowCrossModel || primary.route.modelId === fallback.route.modelId) &&
    primaryCompatibility?.mode === 'compatible-protocol' &&
    fallbackCompatibility?.mode === 'compatible-protocol' &&
    primaryCompatibility.family === fallbackCompatibility.family &&
    (primary.route.protocol === 'legacy-normalized'
      ? fallback.route.protocol === 'legacy-normalized' && fallback.replay.mode === 'new'
      : fallback.replay.mode === 'compatible-protocol');
  if (!declared || !compatible) {
    throw new Error(
      `Fallback route ${fallback.route.routeId} is not an explicit digest-bound compatible candidate of ${primary.route.routeId}.`,
    );
  }
}

function freezeRoute(input: ModelRouteSnapshotInput): ModelRouteSnapshot {
  const capabilities = Object.freeze(sortedRecord(input.capabilities));
  const generationParameters = Object.freeze(sortedRecord(input.generationParameters ?? {}));
  const allowedFallbackRouteIds = Object.freeze([...new Set(input.allowedFallbackRouteIds ?? [])]);
  const compatibility = input.compatibility === undefined
    ? undefined
    : Object.freeze({ ...input.compatibility });
  const digestValue = digest({
    routeId: input.routeId,
    connectionId: input.connectionId,
    providerId: input.providerId,
    modelId: input.modelId,
    protocol: input.protocol,
    codecRevision: input.codecRevision,
    capabilities,
    generationParameters,
    contextTokens: input.contextTokens,
    maxInputTokens: input.maxInputTokens,
    maxOutputTokens: input.maxOutputTokens,
    metadata: {
      source: input.metadata.source,
      revision: input.metadata.revision,
      ...(input.metadata.connectionConfigurationRevision === undefined
        ? {}
        : {
            connectionConfigurationRevision:
              input.metadata.connectionConfigurationRevision,
          }),
      ...(input.metadata.credentialRevision === undefined
        ? {}
        : { credentialRevision: input.metadata.credentialRevision }),
    },
    allowedFallbackRouteIds,
    compatibility,
  });
  return Object.freeze({
    routeId: input.routeId,
    connectionId: input.connectionId,
    providerId: input.providerId,
    modelId: input.modelId,
    protocol: input.protocol,
    codecRevision: input.codecRevision,
    capabilities,
    generationParameters,
    contextTokens: input.contextTokens,
    maxInputTokens: input.maxInputTokens,
    maxOutputTokens: input.maxOutputTokens,
    metadata: Object.freeze({
      source: input.metadata.source,
      revision: input.metadata.revision,
      ...(input.metadata.connectionConfigurationRevision === undefined
        ? {}
        : {
            connectionConfigurationRevision:
              input.metadata.connectionConfigurationRevision,
          }),
      ...(input.metadata.credentialRevision === undefined
        ? {}
        : { credentialRevision: input.metadata.credentialRevision }),
      digest: digestValue,
    }),
    allowedFallbackRouteIds,
    ...(compatibility === undefined ? {} : { compatibility }),
  });
}

function freezeReplay(replay: ModelReplayBinding): ModelReplayBinding {
  if (replay.mode === 'new') return Object.freeze({ mode: 'new' });
  return Object.freeze({
    mode: replay.mode,
    envelopes: Object.freeze(replay.envelopes.map(freezeEnvelope)),
  });
}

function freezeEnvelope(envelope: ModelProtocolEnvelope): ModelProtocolEnvelope {
  return Object.freeze({
    schemaVersion: 1 as const,
    attemptId: envelope.attemptId,
    origin: Object.freeze({ ...envelope.origin }),
    correlations: Object.freeze(envelope.correlations.map((correlation) => Object.freeze({
      ...correlation,
      ...(correlation.wireIdentity === undefined
        ? {}
        : { wireIdentity: Object.freeze({ ...correlation.wireIdentity }) }),
    }))),
    opaqueBlockRefs: Object.freeze([...envelope.opaqueBlockRefs]),
  }) as unknown as ModelProtocolEnvelope;
}

function routeDescriptor(route: ModelRouteSnapshot): ModelRouteSnapshotInput {
  return Object.freeze({
    routeId: route.routeId,
    connectionId: route.connectionId,
    providerId: route.providerId,
    modelId: route.modelId,
    protocol: route.protocol,
    codecRevision: route.codecRevision,
    capabilities: Object.freeze({ ...route.capabilities }),
    generationParameters: Object.freeze({ ...route.generationParameters }),
    contextTokens: route.contextTokens,
    maxInputTokens: route.maxInputTokens,
    maxOutputTokens: route.maxOutputTokens,
    metadata: Object.freeze({ ...route.metadata }),
    allowedFallbackRouteIds: Object.freeze([...route.allowedFallbackRouteIds]),
    ...(route.compatibility === undefined
      ? {}
      : { compatibility: Object.freeze({ ...route.compatibility }) }),
  });
}

function validatePersistedClientBinding(
  descriptor: PersistedModelSessionDescriptor,
): ModelClientBindingMetadata {
  const value = (descriptor as { readonly clientBinding?: unknown }).clientBinding;
  if (value === undefined) {
    throw new ModelClientBindingError(
      'MODEL_CLIENT_BINDING_REQUIRED',
      'The persisted Model Session has no client binding metadata.',
    );
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ModelClientBindingError(
      'MODEL_CLIENT_BINDING_MISMATCH',
      'The persisted Model Session client binding metadata is malformed.',
    );
  }
  const candidate = value as Record<string, unknown>;
  for (const name of [
    'connectionResolutionRevision',
    'connectionConfigurationRevision',
    'credentialRevision',
  ] as const) {
    if (typeof candidate[name] !== 'string' || candidate[name].trim().length === 0) {
      throw new ModelClientBindingError(
        'MODEL_CLIENT_BINDING_MISMATCH',
        `The persisted Model Session client binding ${name} is malformed.`,
      );
    }
  }
  return candidate as ModelClientBindingMetadata;
}

function generationDescriptor(generation: ValidatedGenerationConfig): LlmGenerationConfig {
  return Object.freeze({
    ...generation,
    ...(generation.stop === undefined
      ? {}
      : { stop: Object.freeze([...generation.stop]) }),
  }) as unknown as LlmGenerationConfig;
}

function validateSessionGeneration(
  generation: LlmGenerationConfig,
  route: ModelRouteSnapshotInput,
): LlmGenerationConfig {
  const validated = validateLlmGenerationConfig({
    ...generation,
    ...(generation.stop === undefined ? {} : { stop: [...generation.stop] }),
  });
  if (
    validated.maxOutputTokens !== undefined &&
    route.maxOutputTokens !== null &&
    validated.maxOutputTokens > route.maxOutputTokens
  ) {
    throw new Error(
      `maxOutputTokens ${validated.maxOutputTokens} exceeds frozen route limit ${route.maxOutputTokens}.`,
    );
  }
  for (const parameter of Object.keys(validated) as LlmGenerationParameterName[]) {
    if (validated[parameter] !== undefined && route.generationParameters?.[parameter] === 'unsupported') {
      throw new Error(`Frozen route does not support generation parameter ${parameter}.`);
    }
  }
  if (validated.seed !== undefined) {
    throw new Error('seed is not projected by the canonical Model Protocol codecs.');
  }
  if (validated.reasoningEffort !== undefined) {
    throw new Error('reasoningEffort is not projected by the canonical Model Protocol codecs.');
  }
  return validated;
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
  ] as const) {
    if (!value.trim()) throw new Error(`Model route ${name} must not be empty.`);
  }
  for (const [name, value] of [
    ['metadata.connectionConfigurationRevision', route.metadata.connectionConfigurationRevision],
    ['metadata.credentialRevision', route.metadata.credentialRevision],
  ] as const) {
    if (value !== undefined && !value.trim()) {
      throw new Error(`Model route ${name} must not be empty when supplied.`);
    }
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

function sortedRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}
