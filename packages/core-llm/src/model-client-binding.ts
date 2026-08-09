import type { ModelClient, ModelSession } from './model-client.js';

const MODEL_CLIENT_BINDING_CAPABILITY = Symbol('ModelClientBindingCapability');

export type ModelClientBindingCapability = Readonly<{
  [MODEL_CLIENT_BINDING_CAPABILITY]: true;
}>;

export type ModelClientBindingMetadata = Readonly<{
  connectionResolutionRevision: string;
  connectionConfigurationRevision: string;
  credentialRevision: string;
}>;

export type ModelClientBindingErrorCode =
  | 'MODEL_CLIENT_BINDING_REQUIRED'
  | 'MODEL_CLIENT_BINDING_MISMATCH'
  | 'MODEL_SESSION_NOT_PERSISTABLE';

export class ModelClientBindingError extends Error {
  constructor(
    readonly code: ModelClientBindingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ModelClientBindingError';
  }
}

type ModelClientBindingPayload = ModelClientBindingMetadata & Readonly<{
  routeDigest: string;
  connectionId: string;
  providerId: string;
  modelId: string;
  protocol: string;
  codecRevision: string;
  client: ModelClient;
}>;

const CAPABILITY_PAYLOADS = new WeakMap<object, ModelClientBindingPayload>();
const SESSION_CAPABILITIES = new WeakMap<ModelSession, ModelClientBindingCapability>();

/** Trusted ConnectionManager preparation hook; unavailable from the package root. */
export function bindTrustedModelSessionClient(
  session: ModelSession,
  metadata: ModelClientBindingMetadata,
): void {
  if (
    metadata.connectionResolutionRevision !== session.route.metadata.revision ||
    metadata.connectionConfigurationRevision !==
      session.route.metadata.connectionConfigurationRevision ||
    metadata.credentialRevision !== session.route.metadata.credentialRevision ||
    metadata.connectionConfigurationRevision.length === 0 ||
    metadata.credentialRevision.length === 0
  ) {
    throw new ModelClientBindingError(
      'MODEL_CLIENT_BINDING_MISMATCH',
      'Prepared client metadata does not match the frozen model route.',
    );
  }
  const capability = Object.freeze({
    [MODEL_CLIENT_BINDING_CAPABILITY]: true as const,
  });
  CAPABILITY_PAYLOADS.set(capability, Object.freeze({
    routeDigest: session.route.metadata.digest,
    connectionId: session.route.connectionId,
    providerId: session.route.providerId,
    modelId: session.route.modelId,
    protocol: session.route.protocol,
    codecRevision: session.route.codecRevision,
    connectionResolutionRevision: metadata.connectionResolutionRevision,
    connectionConfigurationRevision: metadata.connectionConfigurationRevision,
    credentialRevision: metadata.credentialRevision,
    client: session.client,
  }));
  SESSION_CAPABILITIES.set(session, capability);
}

export function modelClientBindingCapabilityForSession(
  session: ModelSession,
): ModelClientBindingCapability | undefined {
  return SESSION_CAPABILITIES.get(session);
}

export function requireModelClientBindingPayload(
  capability: ModelClientBindingCapability | undefined,
): ModelClientBindingPayload {
  if (capability === undefined || typeof capability !== 'object' || capability === null) {
    throw new ModelClientBindingError(
      'MODEL_CLIENT_BINDING_REQUIRED',
      'An authenticated Model client binding capability is required.',
    );
  }
  const payload = CAPABILITY_PAYLOADS.get(capability);
  if (payload === undefined) {
    throw new ModelClientBindingError(
      'MODEL_CLIENT_BINDING_REQUIRED',
      'The supplied Model client binding capability is not authentic in this process.',
    );
  }
  return payload;
}

export function attachModelClientBindingCapability(
  session: ModelSession,
  capability: ModelClientBindingCapability,
): void {
  requireModelClientBindingPayload(capability);
  SESSION_CAPABILITIES.set(session, capability);
}
