import {
  describeModelSessionBundle,
  createModelSessionBundle,
  isAuthenticModelSession,
  isAuthenticModelSessionBundle,
  rehydrateModelSessionBundle,
  type ModelSession,
  type ModelSessionBundle,
  type PersistedModelSessionBundleDescriptor,
} from '@dbagent/core-llm';
import type { SqliteAgentJournal } from '../events/sqlite-agent-journal.js';
import { openSessionBindingCommitter } from '../internal/session-binding-authority.js';

export type PersistedModelRuntimeBinding = Readonly<{
  descriptor: PersistedModelSessionBundleDescriptor;
  bindingDigest: string;
}>;

export type SessionModelBinding = Readonly<{
  schemaVersion: 1;
  projectId: string;
  sessionId: string;
  revision: number;
  model: PersistedModelRuntimeBinding;
  updatedAt: string;
}>;

/** Portable command accepted only by the Journal's sealed Session binding authority. */
export type BindPersistedSessionModelCommand = Readonly<{
  projectId: string;
  sessionId: string;
  commandId: string;
  expectedRevision: number;
  model: PersistedModelRuntimeBinding;
}>;

export type BindSessionModelCommand = Readonly<{
  projectId: string;
  sessionId: string;
  commandId: string;
  expectedRevision: number;
  session: ModelSession | ModelSessionBundle;
}>;

export class SessionModelBindingError extends Error {
  constructor(
    readonly code: 'MODEL_BINDING_INVALID' | 'MODEL_BINDING_UNAVAILABLE',
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'SessionModelBindingError';
  }
}

export type ModelSessionResolver = (
  binding: SessionModelBinding,
) => Promise<ModelSession | ModelSessionBundle> | ModelSession | ModelSessionBundle;

export class SessionModelBindingStore {
  constructor(private readonly journal: SqliteAgentJournal) {}

  async bind(command: BindSessionModelCommand): Promise<SessionModelBinding> {
    return await openSessionBindingCommitter(this.journal).commit({
      projectId: command.projectId,
      sessionId: command.sessionId,
      commandId: command.commandId,
      expectedRevision: command.expectedRevision,
      model: describeRuntimeBinding(command.session),
    });
  }

  async get(projectId: string, sessionId: string): Promise<SessionModelBinding | null> {
    return await this.journal.getSessionModelBinding(projectId, sessionId);
  }

  async rehydrate(
    projectId: string,
    sessionId: string,
    resolve: ModelSessionResolver,
  ): Promise<ModelSession | ModelSessionBundle> {
    const binding = await this.get(projectId, sessionId);
    if (binding === null) {
      throw new SessionModelBindingError(
        'MODEL_BINDING_UNAVAILABLE',
        `Session ${sessionId} has no persisted Model binding.`,
      );
    }
    let live: ModelSession | ModelSessionBundle;
    try {
      live = await resolve(binding);
    } catch (error) {
      throw new SessionModelBindingError(
        'MODEL_BINDING_UNAVAILABLE',
        'The exact persisted Model client binding is unavailable.',
        error,
      );
    }
    try {
      return rehydrateExactRuntimeBinding(binding.model, live);
    } catch (error) {
      throw new SessionModelBindingError(
        'MODEL_BINDING_UNAVAILABLE',
        'The live Model binding does not exactly match the persisted Session binding.',
        error,
      );
    }
  }
}

export function describeRuntimeBinding(
  session: ModelSession | ModelSessionBundle,
): PersistedModelRuntimeBinding {
  let bundle: ModelSessionBundle;
  if (isAuthenticModelSessionBundle(session)) bundle = session;
  else if (isAuthenticModelSession(session)) bundle = createModelSessionBundle({ primary: session });
  else {
    throw new SessionModelBindingError(
      'MODEL_BINDING_INVALID',
      'Session model binding requires an authentic Task 2 ModelSession or ModelSessionBundle.',
    );
  }
  const descriptor = describeModelSessionBundle(bundle);
  return deepFreeze({ descriptor, bindingDigest: descriptor.bindingDigest });
}

export function rehydrateExactRuntimeBinding(
  persisted: PersistedModelRuntimeBinding,
  live: ModelSession | ModelSessionBundle,
): ModelSession | ModelSessionBundle {
  const liveBundle = isAuthenticModelSessionBundle(live)
    ? live
    : isAuthenticModelSession(live)
      ? createModelSessionBundle({ primary: live })
      : undefined;
  if (liveBundle === undefined) throw new SessionModelBindingError(
    'MODEL_BINDING_UNAVAILABLE',
    'A persisted ModelSessionBundle requires an exact authentic live binding.',
  );
  const liveByRoute = new Map(
    [liveBundle.primary, ...liveBundle.fallbacks].map(
      (session) => [session.route.routeId, session] as const,
    ),
  );
  const descriptors = [persisted.descriptor.primary, ...persisted.descriptor.fallbacks];
  const bindings = Object.fromEntries(descriptors.map((descriptor) => {
    const bindingSession = liveByRoute.get(descriptor.route.routeId);
    if (bindingSession === undefined) {
      throw new SessionModelBindingError(
        'MODEL_BINDING_UNAVAILABLE',
        `Exact live Model route is unavailable: ${descriptor.route.routeId}.`,
      );
    }
    return [
      descriptor.route.routeId,
      {
        expectedRouteDigest: descriptor.route.metadata.digest,
        expectedSessionDigest: descriptor.bindingDigest,
        expectedCodecRevision: descriptor.route.codecRevision,
        bindingSession,
      },
    ];
  }));
  return rehydrateModelSessionBundle({
    descriptor: persisted.descriptor,
    expectedBundleDigest: persisted.bindingDigest,
    bindings,
  });
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  return Object.freeze(value);
}
