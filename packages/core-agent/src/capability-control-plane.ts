import { createHash } from 'node:crypto';
import { assertPortableValue, toPortableValue, type PortableValue } from '@dbagent/shared';
import type {
  AgentCapabilityAvailability,
  AgentCapabilityActivationBinding,
  AgentCapabilityExternalContextRequirement,
  AgentExternalCapabilityProvider,
  AgentCapabilityModule,
  AgentCapabilityLifecycleContext,
  AgentCapabilityTeardownContext,
  AgentCapabilityModuleRegistration,
  AgentCapabilityModuleRuntime,
  AgentCapabilityContextProviderContribution,
  AgentCapabilityContextRequest,
  AgentCapabilityDiscoveryManifestEntry,
  AgentCapabilityProbeResult,
  AgentCapabilityServiceLease,
  AgentCapabilityServiceSelector,
  AgentCapabilityServiceToken,
  AgentCapabilitySnapshot,
  AgentCapabilityRuntimeSnapshot,
  AgentCapabilitySkillSourceContribution,
  AgentCapabilityStatus,
  AgentInvocationHookContribution,
} from './capability-types.js';
import { snapshotPromptSection, type PromptSection } from './context/prompt-runtime.js';
import { ToolRegistry } from './tool-registry.js';
import type {
  AgentCapabilityStateReference,
} from './types.js';
import type { ToolInvocationContribution } from './tool-registry.js';
import { compareUnicodeCodePoints } from './canonical-text-order.js';
import { bindInvocationHandlerIdentity } from './internal/tool-invocation-handler-identity.js';

export type CapabilityControlPlaneOptions = {
  toolRegistry?: ToolRegistry;
  /** Maximum time one close() call waits; cleanup continues in the background. */
  shutdownTimeoutMs?: number;
  /** Maximum time one cooperative runtime/module teardown attempt may run. */
  teardownTimeoutMs?: number;
};

export class CapabilityPublicationPoisonedError extends Error {
  constructor() {
    super('Capability control plane is poisoned by a failed generation compensation.');
    this.name = 'CapabilityPublicationPoisonedError';
  }
}

export class CapabilityShutdownTimeoutError extends Error {
  readonly code = 'CAPABILITY_SHUTDOWN_TIMEOUT';

  constructor(readonly timeoutMs: number) {
    super(`Capability control plane shutdown is still draining after ${timeoutMs}ms.`);
    this.name = 'CapabilityShutdownTimeoutError';
  }
}

export class CapabilityTeardownTimeoutError extends Error {
  readonly code = 'CAPABILITY_TEARDOWN_TIMEOUT';

  constructor(readonly timeoutMs: number, readonly target: string) {
    super(`Capability teardown did not settle within ${timeoutMs}ms: ${target}`);
    this.name = 'CapabilityTeardownTimeoutError';
  }
}

/**
 * A host-only publication boundary for a provider whose availability and tool
 * catalog must become visible in the same runtime generation.  `commit` must
 * be synchronous: a runtime snapshot can therefore observe either the state
 * before this call or the complete state after it, never an intermediate one.
 */
export type ExternalProviderGenerationPublication<T> = {
  provider?: AgentExternalCapabilityProvider;
  removeProviderId?: string;
  commit: () => T;
  /**
   * Non-throwing compensation supplied by a prepared host transaction. It is
   * mandatory so a failed composite publication cannot expose a half commit.
   */
  rollback: () => void;
};

type RegisteredModule = {
  registration: AgentCapabilityModuleRegistration;
  module: AgentCapabilityModule | undefined;
  loadOperation: Promise<AgentCapabilityModule> | undefined;
  probeOperation: Promise<void> | undefined;
  runtime: AgentCapabilityModuleRuntime | undefined;
  operations: Map<LifecycleOperationKind, Promise<void>>;
  mutationTail: Promise<void>;
  lease: ModuleRuntimeLease | undefined;
  activationSequence: number | undefined;
  contributions: PreparedContributions | undefined;
  /** Runtime generations withdrawn from publication but not yet closed. */
  pendingRetirements: Set<GenerationRetirement>;
  /** Created only while the control plane closes; prevents duplicate disposal. */
  disposeOperation: Promise<void> | undefined;
  disposeWait: Promise<void> | undefined;
  disposeController: AbortController | undefined;
  disposeHung: boolean;
  moduleDisposed: boolean;
  /** Module-wide cleanup failure, kept separate from generation retirement failures. */
  disposeFailure: string | undefined;
  status: AgentCapabilityStatus;
  reason: string | undefined;
  lastFailure:
    | {
        operation: 'resolve' | 'activate' | 'refresh' | 'deactivate' | 'dispose';
        message: string;
      }
    | undefined;
  active: boolean;
  activation: AgentCapabilityExternalContextRequirement | undefined;
  activationBinding: AgentCapabilityActivationBinding | undefined;
  capabilities: Map<string, AgentCapabilityAvailability>;
};

type GenerationRetirement = {
  lease: ModuleRuntimeLease;
  runtime: AgentCapabilityModuleRuntime;
  closeOperation: Promise<void> | undefined;
  closeWait: Promise<void> | undefined;
  closeController: AbortController | undefined;
  closeHung: boolean;
  diagnostic: string | undefined;
};

type PreparedContributions = {
  tools: ToolInvocationContribution[];
  skillSources: AgentCapabilitySkillSourceContribution[];
  promptSections: PromptSection[];
  contextProviders: AgentCapabilityContextProviderContribution[];
  services: Array<{ token: AgentCapabilityServiceToken<unknown>; value: unknown }>;
  stateReferences: Array<{ capabilityId: string; stateId: string; version: string }>;
  invocationHooks: AgentInvocationHookContribution[];
};

type LifecycleOperationKind = 'activate' | 'refresh' | 'deactivate';

type ShutdownPlan = {
  order: RegisteredModule[];
  providersByConsumer: Map<RegisteredModule, Set<RegisteredModule>>;
};

const MODULE_RETIRE_DRAIN_TIMEOUT_MS = 250;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
const DEFAULT_TEARDOWN_TIMEOUT_MS = 2_000;
const MAX_SHUTDOWN_TIMEOUT_MS = 5 * 60_000;
const MAX_PENDING_GENERATION_RETIREMENTS = 32;

export class CapabilityControlPlane {
  readonly tools: ToolRegistry;
  private readonly registrations = new Map<string, RegisteredModule>();
  private readonly externalProviders = new Map<string, AgentExternalCapabilityProvider>();
  private revision = 0;
  private activationSequence = 0;
  private shutdownOperation: Promise<void> | undefined;
  private shutdownPlan: ShutdownPlan | undefined;
  private readonly shutdownTimeoutMs: number;
  private readonly teardownTimeoutMs: number;
  private readonly lifecycleAbort = new AbortController();
  private readonly lifecycleContext: AgentCapabilityLifecycleContext;
  private activeOperationCount = 0;
  private readonly operationDrainWaiters = new Set<() => void>();
  private closing = false;
  private shutdownDraining = false;
  private closed = false;
  private publicationPoisoned = false;

  constructor(options: CapabilityControlPlaneOptions = {}) {
    this.tools = options.toolRegistry ?? new ToolRegistry();
    this.shutdownTimeoutMs = normalizeControlPlaneInteger(
      options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
      'shutdownTimeoutMs',
      1,
      MAX_SHUTDOWN_TIMEOUT_MS,
    );
    this.teardownTimeoutMs = normalizeControlPlaneInteger(
      options.teardownTimeoutMs ?? DEFAULT_TEARDOWN_TIMEOUT_MS,
      'teardownTimeoutMs',
      1,
      MAX_SHUTDOWN_TIMEOUT_MS,
    );
    this.lifecycleContext = Object.freeze({ signal: this.lifecycleAbort.signal });
  }

  register(registration: AgentCapabilityModuleRegistration): void {
    this.assertOpen();
    const stored = validateAndCloneRegistration(registration);
    const key = moduleKey(stored.manifest.id, stored.instanceId);
    if (this.registrations.has(key)) {
      throw new Error(
        `Capability module is already registered: ${stored.manifest.id} (${stored.instanceId})`,
      );
    }
    this.registrations.set(key, {
      registration: stored,
      module: undefined,
      loadOperation: undefined,
      probeOperation: undefined,
      runtime: undefined,
      operations: new Map(),
      mutationTail: Promise.resolve(),
      lease: undefined,
      activationSequence: undefined,
      contributions: undefined,
      pendingRetirements: new Set(),
      disposeOperation: undefined,
      disposeWait: undefined,
      disposeController: undefined,
      disposeHung: false,
      moduleDisposed: false,
      disposeFailure: undefined,
      status: 'unloaded',
      reason: undefined,
      lastFailure: undefined,
      active: false,
      activation: undefined,
      activationBinding: undefined,
      capabilities: new Map(
        stored.manifest.capabilities.map((capability) => [
          capability.id,
          { status: 'unloaded' },
        ]),
      ),
    });
    this.revision += 1;
  }

  async upsertExternalProvider(
    provider: AgentExternalCapabilityProvider,
  ): Promise<AgentCapabilitySnapshot> {
    this.assertOpen();
    const finish = this.beginOperation();
    try {
      const normalized = validateAndCloneExternalProvider(provider);
      this.externalProviders.set(normalized.providerId, normalized);
      this.revision += 1;
      await this.reconcileActiveAvailability();
      return this.snapshot();
    } finally {
      finish();
    }
  }

  async removeExternalProvider(providerId: string): Promise<boolean> {
    this.assertOpen();
    const finish = this.beginOperation();
    try {
      const normalized = providerId.trim();
      if (!normalized) throw new Error('External capability provider id is required.');
      const removed = this.externalProviders.delete(normalized);
      if (removed) {
        this.revision += 1;
        await this.reconcileActiveAvailability();
      }
      return removed;
    } finally {
      finish();
    }
  }

  async publishExternalProviderGeneration<T>(
    publication: ExternalProviderGenerationPublication<T>,
  ): Promise<T> {
    this.assertOpen();
    const finish = this.beginOperation();
    try {
      const hasProvider = publication.provider !== undefined;
      const hasRemoval = publication.removeProviderId !== undefined;
      if (hasProvider === hasRemoval) {
        throw new Error('Publish exactly one external provider generation mutation.');
      }

      const normalizedProvider = publication.provider === undefined
        ? undefined
        : validateAndCloneExternalProvider(publication.provider);
      const removalProviderId = publication.removeProviderId?.trim();
      if (removalProviderId !== undefined && !removalProviderId) {
        throw new Error('External capability provider id is required.');
      }

      const providerId = normalizedProvider?.providerId ?? removalProviderId!;
      const previousProvider = this.externalProviders.get(providerId);
      const notifications = this.tools.deferCatalogNotifications();
      let discardCatalogNotifications = false;
      let committed: T;
      try {
        // Set provider state before installing the catalog, while Registry
        // notifications are deferred.  A synchronous subscriber re-entering
        // from replaceOwnerInvocations therefore observes the complete new
        // pair, never candidate tools with the previous provider.
        if (normalizedProvider) this.externalProviders.set(providerId, normalizedProvider);
        else this.externalProviders.delete(providerId);
        committed = publication.commit();
        this.revision += 1;
      } catch (error) {
        // A rejected composite publication must never notify observers about
        // either its candidate catalog mutation or its compensation.
        discardCatalogNotifications = true;
        let compensationFailure: unknown;
        try {
          publication.rollback();
        } catch (rollbackError) {
          compensationFailure = rollbackError;
        }
        if (previousProvider) this.externalProviders.set(providerId, previousProvider);
        else this.externalProviders.delete(providerId);
        if (compensationFailure !== undefined) {
          this.publicationPoisoned = true;
          discardCatalogNotifications = true;
          throw new Error(
            'Capability generation compensation failed after a rejected publication; host restart is required.',
            { cause: compensationFailure },
          );
        }
        throw error;
      } finally {
        if (discardCatalogNotifications) notifications.discardNotifications();
        else notifications.commitNotifications();
      }

      // Reconciliation may asynchronously stop dependent modules, but is not
      // part of publishing this generation.  The catalog/provider pair remains
      // authoritative even if a dependent module later reports a failure.
      try {
        await this.reconcileActiveAvailability();
      } catch {
        // The generation is already published. A dependent module lifecycle
        // failure must not make the host roll a catalog/provider pair back.
      }
      return committed;
    } finally {
      finish();
    }
  }

  async activate(input: {
    moduleId: string;
    instanceId: string;
    binding?: AgentCapabilityActivationBinding;
  }, operationContext: AgentCapabilityLifecycleContext = this.lifecycleContext): Promise<AgentCapabilitySnapshot> {
    this.assertOpen();
    const context = this.operationContext(operationContext);
    context.signal.throwIfAborted();
    const finish = this.beginOperation();
    try {
      const record = this.requireRecord(input.moduleId, input.instanceId);
      await this.resolveActivationGraph(record, new Set(), context);
      context.signal.throwIfAborted();
      await this.reconcileActiveAvailability();
      const binding = validateActivationBinding(record, input.binding);
      if (record.active) {
        if (!sameActivationBinding(record.activationBinding, binding)) {
          throw new Error(`Capability module is already active with another external context: ${input.moduleId}`);
        }
        return this.snapshot();
      }
      const plan = this.buildActivationPlan(record);
      for (const planned of plan) {
        context.signal.throwIfAborted();
        await this.activateRecord(planned, context, planned === record ? binding : undefined);
      }
      return this.snapshot();
    } finally {
      finish();
    }
  }

  /** Probe one registered module without constructing or publishing its active generation. */
  async probe(input: {
    moduleId: string;
    instanceId: string;
  }, operationContext: AgentCapabilityLifecycleContext = this.lifecycleContext): Promise<AgentCapabilityProbeResult> {
    this.assertOpen();
    const context = this.operationContext(operationContext);
    context.signal.throwIfAborted();
    const finish = this.beginOperation();
    try {
      const record = this.requireRecord(input.moduleId, input.instanceId);
      await this.resolveRecord(record, context);
      context.signal.throwIfAborted();
      return Object.freeze({
        status: record.status,
        ...(record.reason === undefined ? {} : { reason: record.reason }),
        ...(record.activation === undefined
          ? {}
          : { activation: structuredClone(record.activation) }),
      });
    } finally {
      finish();
    }
  }

  /** Materialize a binding only from the current validated probe generation. */
  bindProbeChoice(input: Readonly<{
    moduleId: string;
    instanceId: string;
    providerId: string;
    candidateId: string;
    probeRevision: string;
  }>): AgentCapabilityActivationBinding {
    this.assertOpen();
    const record = this.requireRecord(input.moduleId, input.instanceId);
    const requirement = record.activation;
    if (
      requirement === undefined ||
      requirement.providerId !== input.providerId ||
      requirement.probeRevision !== input.probeRevision
    ) {
      throw new Error('Probe choice does not match the current Capability probe generation.');
    }
    const candidate = requirement.candidates.find(({ candidateId }) => candidateId === input.candidateId);
    if (candidate === undefined) throw new Error('Probe choice candidate is no longer available.');
    return Object.freeze({
      providerId: requirement.providerId,
      candidateId: candidate.candidateId,
      fingerprint: candidate.fingerprint,
      capabilityGeneration: capabilityBindingGeneration(
        record,
        requirement,
        candidate.candidateId,
        candidate.fingerprint,
      ),
    });
  }

  async refresh(input: {
    moduleId: string;
    instanceId: string;
    /**
     * A Capability may publish its next generation from inside an invocation
     * owned by the generation being replaced. In that case waiting for
     * retirement would make the invocation wait for itself. `defer` keeps the
     * atomic publication boundary, then lets the control plane drain and close
     * the retired generation in the background. The default remains `wait` for
     * ordinary host-driven lifecycle changes.
     */
    retirement?: 'wait' | 'defer';
  }, operationContext: AgentCapabilityLifecycleContext = this.lifecycleContext): Promise<AgentCapabilitySnapshot> {
    this.assertOpen();
    const context = this.operationContext(operationContext);
    context.signal.throwIfAborted();
    const finish = this.beginOperation();
    try {
      const record = this.requireRecord(input.moduleId, input.instanceId);
      await this.resolveActivationGraph(record, new Set(), context);
      context.signal.throwIfAborted();
      await this.reconcileActiveAvailability();
      await this.enqueueOperation(record, 'refresh', async () => {
        try {
          this.assertRetirementCapacity(record);
          if (record.status !== 'available' && record.status !== 'degraded') {
            throw unavailableModuleError(record);
          }
          if (!record.active || !record.runtime || !record.lease) {
            throw new Error(
              `Capability module is not active: ${moduleKey(input.moduleId, input.instanceId)}`,
            );
          }
          const previousRuntime = record.runtime;
          const previousLease = record.lease;
          record.module = await this.loadModule(record, context);
          if (this.closing || this.closed) {
            throw new Error(
              `Capability control plane is closing: ${moduleKey(input.moduleId, input.instanceId)}`,
            );
          }
          const candidate = validateModuleRuntime(
            await invokeCapabilityLifecycle(() => record.module!.refresh
              ? record.module!.refresh(previousRuntime, context)
              : record.activationBinding !== undefined && record.module!.resolve !== undefined
                ? record.module!.resolve(record.activationBinding.candidateId, context)
                : record.module!.activate(context)),
            record.module.refresh ? 'refresh' : 'activate',
          );
          if (candidate === previousRuntime) {
            throw new Error(
              `Capability refresh must return a new immutable runtime generation: ${moduleKey(
                input.moduleId,
                input.instanceId,
              )}`,
            );
          }
          const key = moduleKey(input.moduleId, input.instanceId);
          if (this.closing || this.closed) {
            return await this.rejectCandidate(
              record,
              candidate,
              new Error(`Capability control plane is closing: ${key}`),
              key,
            );
          }
          if (record.status !== 'available' && record.status !== 'degraded') {
            return await this.rejectCandidate(
              record,
              candidate,
              unavailableModuleError(record),
              key,
            );
          }
          const missingDependency = (record.registration.manifest.dependencies ?? []).find(
            (dependency) => !this.hasActiveProvider(dependency.capabilityId),
          );
          if (missingDependency) {
            return await this.rejectCandidate(
              record,
              candidate,
              new Error(`Required capability is unavailable: ${missingDependency.capabilityId}`),
              key,
            );
          }
          const candidateLease = new ModuleRuntimeLease(
            moduleKey(record.registration.manifest.id, record.registration.instanceId),
          );
          let prepared: PreparedContributions;
          try {
            prepared = prepareContributions(record, candidate, candidateLease);
          } catch (error) {
            return await this.rejectCandidate(record, candidate, error, key);
          }

          try {
            this.publishModuleGeneration(record, {
              runtime: candidate,
              lease: candidateLease,
              contributions: prepared,
              active: true,
              ...(record.activationBinding === undefined
                ? {}
                : { activationBinding: record.activationBinding }),
            });
          } catch (error) {
            return await this.rejectCandidate(record, candidate, error, key);
          }

          // Publication is complete before retiring the prior generation. A
          // disposal failure is operationally visible, but must never undo or
          // misreport the newly published runtime generation.
          if (input.retirement === 'defer') {
            this.deferPublishedGenerationRetirement(record, previousLease, previousRuntime);
          } else {
            await this.retirePublishedGeneration(record, previousLease, previousRuntime);
          }
        } catch (error) {
          if (this.closing || this.closed) {
            this.syncCleanupFailure(record);
            throw error;
          }
          record.lastFailure = { operation: 'refresh', message: errorMessage(error) };
          this.syncCleanupFailure(record);
          this.revision += 1;
          throw error;
        }
      });
      return this.snapshot();
    } finally {
      finish();
    }
  }

  async deactivate(input: {
    moduleId: string;
    instanceId: string;
  }): Promise<AgentCapabilitySnapshot> {
    if (this.closed) return this.snapshot();
    this.assertOpen();
    const finish = this.beginOperation();
    try {
      const record = this.requireRecord(input.moduleId, input.instanceId);
      for (const dependent of this.affectedActiveDependents(record)) {
        await this.deactivateRecord(dependent);
      }
      await this.deactivateRecord(record);
      return this.snapshot();
    } finally {
      finish();
    }
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (!this.shutdownOperation) {
      if (!this.closing) {
        this.shutdownPlan = this.buildShutdownPlan();
        this.closing = true;
        this.revision += 1;
      }
      if (!this.lifecycleAbort.signal.aborted) {
        this.lifecycleAbort.abort(new Error('Capability control plane is closing.'));
      }
      const operation = this.closeAll();
      this.shutdownOperation = operation;
      void operation.catch(() => {
        this.markShutdownDraining();
        if (this.shutdownOperation === operation) this.shutdownOperation = undefined;
      });
    }
    return waitForShutdown(this.shutdownOperation, this.shutdownTimeoutMs).catch((error: unknown) => {
      if (error instanceof CapabilityShutdownTimeoutError) this.markShutdownDraining();
      throw error;
    });
  }

  snapshot(): AgentCapabilitySnapshot {
    this.assertOperational();
    const modules = [...this.registrations.values()]
      .map((record) => ({
        moduleId: record.registration.manifest.id,
        instanceId: record.registration.instanceId,
        version: record.registration.manifest.version,
        description: record.registration.manifest.description,
        status: record.status,
        active: record.active,
        draining: this.moduleIsDraining(record),
        ...(record.reason === undefined ? {} : { reason: record.reason }),
        ...(record.lastFailure === undefined ? {} : { lastFailure: { ...record.lastFailure } }),
        capabilities: [...record.capabilities.entries()]
          .map(([capabilityId, availability]) => {
            const status =
              this.effectiveCapabilityStatus(record, capabilityId, new Set()) ??
              availability.status;
            const reason =
              status === availability.status
                ? availability.reason
                : 'A required capability is unavailable.';
            return {
              capabilityId,
              status,
              ...(reason === undefined ? {} : { reason }),
            };
          })
          .sort((left, right) => compareUnicodeCodePoints(left.capabilityId, right.capabilityId)),
        contributions: contributionSummary(record.contributions),
      }))
      .sort((left, right) =>
        compareUnicodeCodePoints(
          `${left.moduleId}\0${left.instanceId}`,
          `${right.moduleId}\0${right.instanceId}`,
        ),
      );
    const byCapability = new Map<string, AgentCapabilityStatus[]>();
    for (const module of modules) {
      for (const capability of module.capabilities) {
        const statuses = byCapability.get(capability.capabilityId) ?? [];
        statuses.push(capability.status);
        byCapability.set(capability.capabilityId, statuses);
      }
    }
    const externalProviders = [...this.externalProviders.values()]
      .map((provider) => ({
        providerId: provider.providerId,
        description: provider.description,
        status: provider.status,
        active: provider.active,
        ...(provider.reason === undefined ? {} : { reason: provider.reason }),
        capabilities: provider.capabilities
          .map((capability) => ({
            capabilityId: capability.id,
            status: provider.status,
            ...(provider.reason === undefined ? {} : { reason: provider.reason }),
          }))
          .sort((left, right) => compareUnicodeCodePoints(left.capabilityId, right.capabilityId)),
      }))
      .sort((left, right) => compareUnicodeCodePoints(left.providerId, right.providerId));
    for (const provider of externalProviders) {
      for (const capability of provider.capabilities) {
        const statuses = byCapability.get(capability.capabilityId) ?? [];
        statuses.push(capability.status);
        byCapability.set(capability.capabilityId, statuses);
      }
    }
    return deepFreeze({
      revision: this.revision,
      phase: this.closed
        ? 'closed'
        : this.closing
          ? (this.shutdownDraining ? 'draining' : 'closing')
          : 'running',
      modules,
      externalProviders,
      capabilities: [...byCapability.entries()]
        .map(([capabilityId, statuses]) => ({
          capabilityId,
          status: aggregateStatus(statuses),
        }))
        .sort((left, right) => compareUnicodeCodePoints(left.capabilityId, right.capabilityId)),
    });
  }

  /**
   * Captures semantic metadata plus the latest bounded probe result.  An
   * untouched registration remains `unloaded`; a failed selection keeps its
   * actionable availability instead of being projected as loadable again.
   * `target` remains Host-only metadata.
   */
  captureDiscoveryManifest(): readonly AgentCapabilityDiscoveryManifestEntry[] {
    this.assertOpen();
    return deepFreeze([...this.registrations.values()]
      .filter((record) => !record.active)
      .flatMap((record) => record.registration.manifest.capabilities.map((capability) => {
        const declared = record.capabilities.get(capability.id) ?? { status: record.status };
        const status = this.effectiveCapabilityStatus(record, capability.id, new Set()) ??
          declared.status;
        const reason = normalizeCapabilityDiagnostic(
          declared.reason ?? record.reason ?? record.lastFailure?.message ?? '',
        );
        return {
          name: capability.id,
          description: capability.description,
          status,
          ...(reason === undefined ? {} : { reason }),
          ...(record.activation === undefined
            ? {}
            : { activation: structuredClone(record.activation) }),
          target: {
            moduleId: record.registration.manifest.id,
            instanceId: record.registration.instanceId,
          },
        };
      }))
      .sort((left, right) =>
        compareUnicodeCodePoints(left.name, right.name) ||
        compareUnicodeCodePoints(left.target.moduleId, right.target.moduleId) ||
        compareUnicodeCodePoints(left.target.instanceId, right.target.instanceId)));
  }

  captureRuntimeSnapshot(): AgentCapabilityRuntimeSnapshot {
    this.assertOpen();
    const moduleReleases: Array<() => void> = [];
    let tools: ReturnType<ToolRegistry['captureSnapshot']> | undefined;
    try {
      for (const record of this.activeRecords()) {
        if (record.lease) moduleReleases.push(record.lease.retain());
      }
      tools = this.tools.captureSnapshot();
      const capabilities = this.snapshot();
      const skillSources = this.skillSources();
      const promptSections = this.promptSections();
      const contextProviders = this.contextProviders();
      const invocationHooks = this.invocationHooks();
      const stateReferences = this.stateReferences();
      const identity = runtimeSnapshotIdentity({
        capabilities,
        tools,
        skillSources,
        promptSections,
        contextProviders,
        invocationHooks,
        stateReferences,
      });
      let released = false;
      return Object.freeze({
        identity,
        capabilities,
        tools,
        skillSources,
        promptSections,
        contextProviders,
        invocationHooks,
        stateReferences,
        release: () => {
          if (released) return;
          released = true;
          tools!.release();
          for (const release of moduleReleases.reverse()) release();
        },
      });
    } catch (error) {
      tools?.release();
      for (const release of moduleReleases.reverse()) release();
      throw error;
    }
  }

  satisfies(
    requirements: readonly { capabilityId: string }[],
    options: { activeOnly?: boolean } = {},
  ): boolean {
    return requirements.every((requirement) => {
      const capabilityId = requirement.capabilityId.trim();
      if (!capabilityId) return false;
      const externalSatisfied = [...this.externalProviders.values()].some(
        (provider) =>
          (options.activeOnly !== true || provider.active) &&
          provider.capabilities.some((capability) => capability.id === capabilityId) &&
          (provider.status === 'available' || provider.status === 'degraded'),
      );
      if (externalSatisfied) return true;
      return [...this.registrations.values()].some((record) => {
        if (options.activeOnly === true && !record.active) return false;
        const status = this.effectiveCapabilityStatus(record, capabilityId, new Set(), options);
        return status === 'available' || status === 'degraded';
      });
    });
  }

  skillSources(): readonly AgentCapabilitySkillSourceContribution[] {
    return deepFreeze(
      this.activeRecords().flatMap((record) =>
        (record.contributions?.skillSources ?? []).map((source) => ({
          ...source,
          id: contributionOwner(
            record.registration.manifest.id,
            `${record.registration.instanceId}:${source.id}`,
          ),
        })),
      ),
    );
  }

  promptSections(): readonly PromptSection[] {
    return deepFreeze(
      this.activeRecords().flatMap((record) =>
        (record.contributions?.promptSections ?? []).map((section) => structuredClone(section)),
      ),
    );
  }

  contextProviders(): readonly AgentCapabilityContextProviderContribution[] {
    return Object.freeze(
      this.activeRecords().flatMap((record) =>
        (record.contributions?.contextProviders ?? []).map((provider) => Object.freeze({
          id: provider.id,
          revision: provider.revision,
          provide: provider.provide,
        })),
      ),
    );
  }

  invocationHooks(): readonly AgentInvocationHookContribution[] {
    return Object.freeze(this.activeRecords().flatMap((record) =>
      (record.contributions?.invocationHooks ?? []).map((hook) => Object.freeze({
        id: hook.id,
        revision: hook.revision,
        ...(hook.before === undefined ? {} : { before: hook.before }),
        ...(hook.after === undefined ? {} : { after: hook.after }),
      })),
    ));
  }

  stateReferences(): readonly AgentCapabilityStateReference[] {
    return deepFreeze(
      this.activeRecords().flatMap((record) =>
        (record.contributions?.stateReferences ?? []).map((reference) => ({
          ...reference,
          moduleId: record.registration.manifest.id,
          instanceId: record.registration.instanceId,
        })),
      ),
    );
  }

  captureService<T>(
    token: AgentCapabilityServiceToken<T>,
    selector?: AgentCapabilityServiceSelector,
  ): AgentCapabilityServiceLease<T> | undefined {
    this.assertOpen();
    const matches = this.activeRecords()
      .filter(
        (record) =>
          selector === undefined ||
          (record.registration.manifest.id === selector.moduleId &&
            record.registration.instanceId === selector.instanceId),
      )
      .flatMap((record) =>
        (record.contributions?.services ?? [])
          .filter((service) => service.token.id === token.id)
          .map((service) => ({ record, value: service.value as T })),
      );
    if (matches.length > 1 && selector === undefined) {
      throw new Error(
        `Capability service is provided by multiple active module instances: ${token.id}`,
      );
    }
    const match = matches[0];
    if (!match?.record.lease) return undefined;
    const release = match.record.lease.retainService();
    return Object.freeze({
      moduleId: match.record.registration.manifest.id,
      instanceId: match.record.registration.instanceId,
      value: match.value,
      release,
    });
  }

  private operationContext(
    requested: AgentCapabilityLifecycleContext,
  ): AgentCapabilityLifecycleContext {
    const deadline = requested.deadline;
    if (deadline === undefined && requested.signal === this.lifecycleContext.signal) {
      return this.lifecycleContext;
    }
    let deadlineSignal: AbortSignal | undefined;
    if (deadline !== undefined) {
      const deadlineAt = Date.parse(deadline);
      if (!Number.isFinite(deadlineAt)) throw new TypeError('Capability lifecycle deadline is invalid.');
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) throw new Error('Capability lifecycle deadline expired.');
      deadlineSignal = AbortSignal.timeout(Math.min(remaining, 2_147_483_647));
    }
    return Object.freeze({
      signal: AbortSignal.any([
        this.lifecycleContext.signal,
        requested.signal,
        ...(deadlineSignal === undefined ? [] : [deadlineSignal]),
      ]),
      ...(deadline === undefined ? {} : { deadline }),
    });
  }

  private async activateRecord(
    record: RegisteredModule,
    context: AgentCapabilityLifecycleContext = this.lifecycleContext,
    binding?: AgentCapabilityActivationBinding,
  ): Promise<void> {
    if (record.active) return;
    await this.enqueueOperation(record, 'activate', async () => {
      try {
        context.signal.throwIfAborted();
        await this.activateRecordOnce(record, context, binding);
        if (record.lastFailure?.operation === 'activate') record.lastFailure = undefined;
        this.syncCleanupFailure(record);
      } catch (error) {
        if (this.closing || this.closed) {
          this.syncCleanupFailure(record);
          throw error;
        }
        record.lastFailure = { operation: 'activate', message: errorMessage(error) };
        this.syncCleanupFailure(record);
        this.revision += 1;
        throw error;
      }
    });
  }

  private async activateRecordOnce(
    record: RegisteredModule,
    context: AgentCapabilityLifecycleContext = this.lifecycleContext,
    binding?: AgentCapabilityActivationBinding,
  ): Promise<void> {
    const key = moduleKey(record.registration.manifest.id, record.registration.instanceId);
    context.signal.throwIfAborted();
    if (record.status !== 'available' && record.status !== 'degraded') {
      throw unavailableModuleError(record);
    }
    record.module = await this.loadModule(record, context);
    if (this.closing || this.closed) {
      throw new Error(`Capability control plane is closing: ${key}`);
    }
    const candidate = validateModuleRuntime(await invokeCapabilityLifecycle(() => {
      if (binding === undefined) return record.module!.activate(context);
      if (record.module!.resolve === undefined) {
        throw new Error(`Capability module does not implement external choice resolution: ${key}`);
      }
      return record.module!.resolve(binding.candidateId, context);
    }), 'activate');
    if (this.closing || this.closed || context.signal.aborted) {
      return await this.rejectCandidate(
        record,
        candidate,
        context.signal.aborted
          ? new Error(`Capability activation was cancelled: ${key}`)
          : new Error(`Capability control plane is closing: ${key}`),
        key,
      );
    }
    const missingDependency = (record.registration.manifest.dependencies ?? []).find(
      (dependency) => !this.hasActiveProvider(dependency.capabilityId),
    );
    if (missingDependency) {
      return await this.rejectCandidate(
        record,
        candidate,
        new Error(`Required capability is unavailable: ${missingDependency.capabilityId}`),
        key,
      );
    }
    const lease = new ModuleRuntimeLease(key);
    let prepared: PreparedContributions;
    try {
      prepared = prepareContributions(record, candidate, lease);
    } catch (error) {
      return await this.rejectCandidate(record, candidate, error, key);
    }
    try {
      this.publishModuleGeneration(record, {
        runtime: candidate,
        lease,
        contributions: prepared,
        active: true,
        ...(binding === undefined ? {} : { activationBinding: binding }),
        activationSequence: ++this.activationSequence,
      });
    } catch (error) {
      return await this.rejectCandidate(record, candidate, error, key);
    }
  }

  private async deactivateRecord(record: RegisteredModule): Promise<void> {
    await this.enqueueOperation(record, 'deactivate', async () => {
      if (!record.active || !record.runtime || !record.lease) return;
      try {
        const runtime = record.runtime;
        const lease = record.lease;
        this.publishModuleGeneration(record, {
          runtime: undefined,
          lease: undefined,
          contributions: undefined,
          active: false,
          ...(record.activationSequence === undefined
            ? {}
            : { activationSequence: record.activationSequence }),
        });
        await this.retirePublishedGeneration(record, lease, runtime);
        if (record.lastFailure?.operation === 'deactivate') record.lastFailure = undefined;
      } catch (error) {
        record.lastFailure = { operation: 'deactivate', message: errorMessage(error) };
        this.syncCleanupFailure(record);
        this.revision += 1;
        throw error;
      }
    });
  }

  /**
   * Publishes the module record and its Tool catalog as one observer-visible
   * generation. ToolRegistry mutations are prepared atomically; catalog
   * listeners run only after every companion record field is committed.
   */
  private publishModuleGeneration(
    record: RegisteredModule,
    generation: {
      runtime: AgentCapabilityModuleRuntime | undefined;
      lease: ModuleRuntimeLease | undefined;
      contributions: PreparedContributions | undefined;
      active: boolean;
      activationBinding?: AgentCapabilityActivationBinding;
      activationSequence?: number;
    },
  ): void {
    const previous = {
      runtime: record.runtime,
      lease: record.lease,
      contributions: record.contributions,
      active: record.active,
      activationBinding: record.activationBinding,
      activationSequence: record.activationSequence,
      lastFailure: record.lastFailure,
      revision: this.revision,
    };
    const notifications = this.tools.deferCatalogNotifications();
    try {
      record.runtime = generation.runtime;
      record.lease = generation.lease;
      record.contributions = generation.contributions;
      record.active = generation.active;
      record.activationBinding = generation.active
        ? generation.activationBinding
        : undefined;
      record.activationSequence = generation.activationSequence ?? previous.activationSequence;
      const cleanupFailureMessage = cleanupFailure(record);
      record.lastFailure = cleanupFailureMessage === undefined
        ? undefined
        : { operation: 'dispose', message: cleanupFailureMessage };
      this.tools.replaceOwnerInvocations(
        contributionOwner(record.registration.manifest.id, record.registration.instanceId),
        generation.contributions?.tools ?? [],
        ...(generation.lease === undefined ? [] : [{ snapshotLifecycle: generation.lease }]),
      );
      this.revision += 1;
    } catch (error) {
      record.runtime = previous.runtime;
      record.lease = previous.lease;
      record.contributions = previous.contributions;
      record.active = previous.active;
      record.activationBinding = previous.activationBinding;
      record.activationSequence = previous.activationSequence;
      record.lastFailure = previous.lastFailure;
      this.revision = previous.revision;
      notifications.discardNotifications();
      throw error;
    }
    notifications.commitNotifications();
  }

  /**
   * Owns cleanup for a runtime which never became authoritative. A failed
   * candidate close is retained like any other generation retirement so host
   * shutdown cannot dispose module-wide resources underneath it.
   */
  private async rejectCandidate(
    record: RegisteredModule,
    candidate: AgentCapabilityModuleRuntime,
    cause: unknown,
    key: string,
  ): Promise<never> {
    const lease = new ModuleRuntimeLease(`${key}:candidate`);
    const retirement = this.beginGenerationRetirement(record, lease, candidate);
    if (this.closing) lease.stopForShutdown();
    else lease.stopAccepting();
    try {
      await this.attemptGenerationRetirement(record, retirement);
    } catch (closeError) {
      throw new AggregateError(
        [cause, closeError],
        `Capability candidate cleanup failed: ${key}`,
      );
    }
    throw cause;
  }

  /** Retires one immutable generation without rolling back its replacement. */
  private async retirePublishedGeneration(
    record: RegisteredModule,
    lease: ModuleRuntimeLease,
    runtime: AgentCapabilityModuleRuntime,
  ): Promise<void> {
    const retirement = this.beginGenerationRetirement(record, lease, runtime);
    if (this.closing) lease.stopForShutdown();
    else lease.stopAccepting();
    if (await lease.drainWithin(MODULE_RETIRE_DRAIN_TIMEOUT_MS)) {
      try {
        await this.attemptGenerationRetirement(record, retirement);
      } catch {
        // The replacement generation is already authoritative. The retained
        // descriptor makes this close retryable during host shutdown.
      }
      return;
    }
    this.recordRetirementDiagnostic(
      record,
      retirement,
      new Error(`Capability generation retirement timed out after ${MODULE_RETIRE_DRAIN_TIMEOUT_MS}ms.`),
    );
    void this.attemptGenerationRetirement(record, retirement).catch(() => undefined);
  }

  private deferPublishedGenerationRetirement(
    record: RegisteredModule,
    lease: ModuleRuntimeLease,
    runtime: AgentCapabilityModuleRuntime,
  ): void {
    const retirement = this.beginGenerationRetirement(record, lease, runtime);
    if (this.closing) lease.stopForShutdown();
    else lease.stopAccepting();
    void this.attemptGenerationRetirement(record, retirement).catch(() => undefined);
    void lease.drainWithin(MODULE_RETIRE_DRAIN_TIMEOUT_MS).then((drained) => {
      if (drained || !record.pendingRetirements.has(retirement)) return;
      this.recordRetirementDiagnostic(
        record,
        retirement,
        new Error(`Capability generation retirement timed out after ${MODULE_RETIRE_DRAIN_TIMEOUT_MS}ms.`),
      );
    });
  }

  private beginGenerationRetirement(
    record: RegisteredModule,
    lease: ModuleRuntimeLease,
    runtime: AgentCapabilityModuleRuntime,
  ): GenerationRetirement {
    const existing = [...record.pendingRetirements].find((candidate) => candidate.lease === lease);
    if (existing) return existing;
    const retirement: GenerationRetirement = {
      lease,
      runtime,
      closeOperation: undefined,
      closeWait: undefined,
      closeController: undefined,
      closeHung: false,
      diagnostic: undefined,
    };
    record.pendingRetirements.add(retirement);
    return retirement;
  }

  private attemptGenerationRetirement(
    record: RegisteredModule,
    retirement: GenerationRetirement,
  ): Promise<void> {
    if (retirement.closeWait) return retirement.closeWait;
    if (retirement.closeOperation) {
      if (retirement.closeHung) {
        return Promise.reject(new CapabilityTeardownTimeoutError(
          this.teardownTimeoutMs,
          `${moduleLabel(record)} runtime generation`,
        ));
      }
      return retirement.closeOperation;
    }
    const wait = retirement.lease.drain().then(async () => {
      const controller = new AbortController();
      const context: AgentCapabilityTeardownContext = Object.freeze({ signal: controller.signal });
      const operation = Promise.resolve().then(async () => {
        await invokeCapabilityLifecycle(() => retirement.runtime.close?.(context));
      });
      retirement.closeController = controller;
      retirement.closeOperation = operation;
      void operation.then(
        () => {
          if (retirement.closeOperation !== operation) return;
          retirement.closeOperation = undefined;
          retirement.closeController = undefined;
          retirement.closeHung = false;
          record.pendingRetirements.delete(retirement);
          retirement.diagnostic = undefined;
          this.syncCleanupFailure(record);
        },
        (error: unknown) => {
          if (retirement.closeOperation !== operation) return;
          retirement.closeOperation = undefined;
          retirement.closeController = undefined;
          retirement.closeHung = false;
          this.recordRetirementDiagnostic(record, retirement, error);
        },
      );
      await waitForTeardown(operation, {
        timeoutMs: this.teardownTimeoutMs,
        target: `${moduleLabel(record)} runtime generation`,
        controller,
        onTimeout: (error) => {
          retirement.closeHung = true;
          this.recordRetirementDiagnostic(record, retirement, error);
        },
      });
    });
    retirement.closeWait = wait;
    const clearWait = () => {
      if (retirement.closeWait === wait) retirement.closeWait = undefined;
    };
    void wait.then(clearWait, clearWait);
    return wait;
  }

  private assertRetirementCapacity(record: RegisteredModule): void {
    if (record.pendingRetirements.size < MAX_PENDING_GENERATION_RETIREMENTS) return;
    throw new Error(
      `Capability module has too many generations still retiring: ${moduleKey(
        record.registration.manifest.id,
        record.registration.instanceId,
      )}`,
    );
  }

  private recordRetirementDiagnostic(
    record: RegisteredModule,
    retirement: GenerationRetirement,
    error: unknown,
  ): void {
    retirement.diagnostic = errorMessage(error);
    this.syncCleanupFailure(record);
  }

  private syncCleanupFailure(record: RegisteredModule): void {
    const message = cleanupFailure(record);
    const previous = record.lastFailure;
    if (message === undefined) {
      if (previous?.operation !== 'dispose') return;
      record.lastFailure = undefined;
      this.revision += 1;
      return;
    }
    if (previous?.operation === 'dispose' && previous.message === message) return;
    record.lastFailure = { operation: 'dispose', message };
    this.revision += 1;
  }

  private disposeModuleWhenSafe(record: RegisteredModule): Promise<void> {
    if (record.moduleDisposed) return Promise.resolve();
    if (record.disposeWait) return record.disposeWait;
    if (record.disposeOperation) {
      if (record.disposeHung) {
        return Promise.reject(new CapabilityTeardownTimeoutError(
          this.teardownTimeoutMs,
          `${moduleLabel(record)} module`,
        ));
      }
      return record.disposeOperation;
    }
    const controller = new AbortController();
    const context: AgentCapabilityTeardownContext = Object.freeze({ signal: controller.signal });
    const operation = Promise.resolve().then(async () => {
      const dispose = record.module?.dispose ?? record.registration.dispose;
      await invokeCapabilityLifecycle(() => dispose?.(context));
    });
    record.disposeOperation = operation;
    record.disposeController = controller;
    void operation.then(
      () => {
        if (record.disposeOperation !== operation) return;
        record.moduleDisposed = true;
        record.disposeOperation = undefined;
        record.disposeController = undefined;
        record.disposeHung = false;
        record.disposeFailure = undefined;
        this.syncCleanupFailure(record);
      },
      (error: unknown) => {
        if (record.disposeOperation !== operation) return;
        record.disposeOperation = undefined;
        record.disposeController = undefined;
        record.disposeHung = false;
        record.disposeFailure = errorMessage(error);
        this.syncCleanupFailure(record);
      },
    );
    const wait = waitForTeardown(operation, {
      timeoutMs: this.teardownTimeoutMs,
      target: `${moduleLabel(record)} module`,
      controller,
      onTimeout: (error) => {
        record.disposeHung = true;
        record.disposeFailure = error.message;
        this.syncCleanupFailure(record);
      },
    });
    record.disposeWait = wait;
    const clearWait = () => {
      if (record.disposeWait === wait) record.disposeWait = undefined;
    };
    void wait.then(clearWait, clearWait);
    return wait;
  }

  private enqueueOperation(
    record: RegisteredModule,
    kind: LifecycleOperationKind,
    action: () => void | Promise<void>,
  ): Promise<void> {
    const existing = record.operations.get(kind);
    if (existing) return existing;
    const operation = record.mutationTail.then(action, action);
    record.operations.set(kind, operation);
    record.mutationTail = operation.then(
      () => undefined,
      () => undefined,
    );
    const clear = () => {
      if (record.operations.get(kind) === operation) record.operations.delete(kind);
    };
    void operation.then(clear, clear);
    return operation;
  }

  private async closeAll(): Promise<void> {
    const withdrawalFailures = new Map<RegisteredModule, unknown>();
    const shutdownPlan = this.shutdownPlan ?? this.buildShutdownPlan();
    this.shutdownPlan = shutdownPlan;
    this.quiesceForShutdown(withdrawalFailures);
    await this.waitForActiveOperations();
    // A lifecycle operation which began before close may have reached a
    // boundary after the first quiesce. Publication fencing should prevent
    // that, while this second pass is the final defensive withdrawal.
    this.quiesceForShutdown(withdrawalFailures);
    const failures: unknown[] = [...withdrawalFailures.values()];
    const loaded = shutdownPlan.order.filter(
      (record) => record.module !== undefined || record.registration.dispose !== undefined,
    );
    const blockedProviders = new Set<RegisteredModule>();
    for (const record of loaded) {
      if (blockedProviders.has(record)) {
        for (const provider of shutdownPlan.providersByConsumer.get(record) ?? []) {
          blockedProviders.add(provider);
        }
        continue;
      }
      if (record.active) {
        for (const provider of shutdownPlan.providersByConsumer.get(record) ?? []) {
          blockedProviders.add(provider);
        }
        continue;
      }
      for (const retirement of record.pendingRetirements) retirement.lease.stopForShutdown();
      const retirementResults = await Promise.allSettled(
        [...record.pendingRetirements].map(async (retirement) =>
          await this.attemptGenerationRetirement(record, retirement)),
      );
      const retirementFailures = retirementResults
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason instanceof Error ? result.reason : new Error(String(result.reason)));
      if (retirementFailures.length > 0) {
        failures.push(new AggregateError(
          retirementFailures,
          `Capability module runtime did not close cleanly: ${record.registration.manifest.id}.`,
        ));
        for (const provider of shutdownPlan.providersByConsumer.get(record) ?? []) {
          blockedProviders.add(provider);
        }
        continue;
      }
      try {
        await this.disposeModuleWhenSafe(record);
        record.disposeFailure = undefined;
        this.syncCleanupFailure(record);
      } catch (error) {
        record.disposeFailure = errorMessage(error);
        this.syncCleanupFailure(record);
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'One or more capability modules failed to close.');
    }
    this.closed = true;
    this.closing = false;
    this.shutdownDraining = false;
    this.revision += 1;
  }

  private quiesceForShutdown(failures: Map<RegisteredModule, unknown>): void {
    const active = [...this.registrations.values()]
      .filter((record) => record.active)
      .sort((left, right) => (right.activationSequence ?? 0) - (left.activationSequence ?? 0));
    for (const record of active) {
      const runtime = record.runtime;
      const lease = record.lease;
      if (!runtime || !lease) {
        const error = new Error(
          `Active Capability module has no runtime generation: ${moduleKey(
            record.registration.manifest.id,
            record.registration.instanceId,
          )}`,
        );
        failures.set(record, error);
        continue;
      }
      lease.stopForShutdown();
      try {
        this.publishModuleGeneration(record, {
          runtime: undefined,
          lease: undefined,
          contributions: undefined,
          active: false,
          ...(record.activationSequence === undefined
            ? {}
            : { activationSequence: record.activationSequence }),
        });
        // Withdrawal is synchronous, but teardown is sequenced by closeAll()
        // from the active dependency graph so a provider cannot disappear
        // before an active dependent has finished closing.
        this.beginGenerationRetirement(record, lease, runtime);
        failures.delete(record);
      } catch (error) {
        failures.set(record, error);
        record.lastFailure = { operation: 'deactivate', message: errorMessage(error) };
        this.syncCleanupFailure(record);
        this.revision += 1;
      }
    }
    for (const record of this.registrations.values()) {
      for (const retirement of record.pendingRetirements) retirement.lease.stopForShutdown();
    }
  }

  /** Dependents precede every active in-process provider they may rely on. */
  private buildShutdownPlan(): ShutdownPlan {
    const records = [...this.registrations.values()];
    const outgoing = new Map(records.map((record) => [record, new Set<RegisteredModule>()]));
    const indegree = new Map(records.map((record) => [record, 0]));
    for (const consumer of records) {
      if (!consumer.active) continue;
      for (const dependency of consumer.registration.manifest.dependencies ?? []) {
        for (const provider of records) {
          if (!provider.active || provider === consumer) continue;
          const status = provider.capabilities.get(dependency.capabilityId)?.status;
          if (status !== 'available' && status !== 'degraded') continue;
          const edges = outgoing.get(consumer)!;
          if (edges.has(provider)) continue;
          edges.add(provider);
          indegree.set(provider, indegree.get(provider)! + 1);
        }
      }
    }
    const compare = (left: RegisteredModule, right: RegisteredModule) =>
      (right.activationSequence ?? 0) - (left.activationSequence ?? 0) ||
      compareUnicodeCodePoints(
        moduleKey(left.registration.manifest.id, left.registration.instanceId),
        moduleKey(right.registration.manifest.id, right.registration.instanceId),
      );
    const ready = records.filter((record) => indegree.get(record) === 0).sort(compare);
    const ordered: RegisteredModule[] = [];
    while (ready.length > 0) {
      const current = ready.shift()!;
      ordered.push(current);
      for (const provider of [...outgoing.get(current)!].sort(compare)) {
        const next = indegree.get(provider)! - 1;
        indegree.set(provider, next);
        if (next === 0) {
          ready.push(provider);
          ready.sort(compare);
        }
      }
    }
    if (ordered.length !== records.length) {
      const visited = new Set(ordered);
      ordered.push(...records.filter((record) => !visited.has(record)).sort(compare));
    }
    return { order: ordered, providersByConsumer: outgoing };
  }

  private assertOpen(): void {
    this.assertOperational();
    if (this.closing || this.closed) throw new Error('Capability control plane is closed.');
  }

  private assertOperational(): void {
    if (this.publicationPoisoned) throw new CapabilityPublicationPoisonedError();
  }

  private markShutdownDraining(): void {
    if (this.shutdownDraining || this.closed) return;
    this.shutdownDraining = true;
    this.revision += 1;
  }

  private moduleIsDraining(record: RegisteredModule): boolean {
    if (!this.closing) return false;
    return record.active || record.loadOperation !== undefined || record.probeOperation !== undefined ||
      record.operations.size > 0 || record.pendingRetirements.size > 0 ||
      (!record.moduleDisposed &&
        (record.disposeOperation !== undefined || record.disposeFailure !== undefined));
  }

  private beginOperation(): () => void {
    this.activeOperationCount += 1;
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      this.activeOperationCount -= 1;
      if (this.activeOperationCount !== 0) return;
      for (const resolve of this.operationDrainWaiters) resolve();
      this.operationDrainWaiters.clear();
    };
  }

  private waitForActiveOperations(): Promise<void> {
    if (this.activeOperationCount === 0) return Promise.resolve();
    return new Promise((resolve) => this.operationDrainWaiters.add(resolve));
  }

  private activeRecords(): RegisteredModule[] {
    return [...this.registrations.values()]
      .filter((record) => record.active)
      .sort((left, right) => (left.activationSequence ?? 0) - (right.activationSequence ?? 0));
  }

  private affectedActiveDependents(target: RegisteredModule): RegisteredModule[] {
    const removed = new Set<RegisteredModule>([target]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const candidate of this.registrations.values()) {
        if (!candidate.active || removed.has(candidate)) continue;
        const losesDependency = (candidate.registration.manifest.dependencies ?? []).some(
          (dependency) => !this.hasActiveProvider(dependency.capabilityId, removed),
        );
        if (!losesDependency) continue;
        removed.add(candidate);
        changed = true;
      }
    }
    removed.delete(target);
    return [...removed].sort(
      (left, right) => (right.activationSequence ?? 0) - (left.activationSequence ?? 0),
    );
  }

  private async reconcileActiveAvailability(): Promise<void> {
    const active = this.activeRecords().sort(
      (left, right) => (right.activationSequence ?? 0) - (left.activationSequence ?? 0),
    );
    for (const record of active) {
      if (!record.active) continue;
      const ownUnavailable = record.status !== 'available' && record.status !== 'degraded';
      const dependencyUnavailable = (record.registration.manifest.dependencies ?? []).some(
        (dependency) => !this.hasActiveProvider(dependency.capabilityId),
      );
      if (ownUnavailable || dependencyUnavailable) await this.deactivateRecord(record);
    }
  }

  private hasActiveProvider(
    capabilityId: string,
    removed: ReadonlySet<RegisteredModule> = new Set(),
  ): boolean {
    if (
      [...this.externalProviders.values()].some(
        (provider) =>
          provider.active &&
          (provider.status === 'available' || provider.status === 'degraded') &&
          provider.capabilities.some((capability) => capability.id === capabilityId),
      )
    ) {
      return true;
    }
    return [...this.registrations.values()].some(
      (provider) =>
        provider.active &&
        !removed.has(provider) &&
        (provider.capabilities.get(capabilityId)?.status === 'available' ||
          provider.capabilities.get(capabilityId)?.status === 'degraded'),
    );
  }

  private buildActivationPlan(target: RegisteredModule): RegisteredModule[] {
    const visited = new Set<string>();
    const visiting: string[] = [];
    const plan: RegisteredModule[] = [];
    const visit = (record: RegisteredModule): void => {
      const key = moduleKey(record.registration.manifest.id, record.registration.instanceId);
      const cycleIndex = visiting.indexOf(key);
      if (cycleIndex >= 0) {
        throw new Error(
          `Capability dependency cycle: ${[...visiting.slice(cycleIndex), key].join(' -> ')}`,
        );
      }
      if (visited.has(key)) return;
      if (record.status !== 'available' && record.status !== 'degraded') {
        throw unavailableModuleError(record);
      }
      visiting.push(key);
      for (const dependency of record.registration.manifest.dependencies ?? []) {
        if (this.hasActiveProvider(dependency.capabilityId)) continue;
        const provider = this.availableProviders(dependency.capabilityId)[0];
        if (!provider) {
          throw new Error(`Required capability is unavailable: ${dependency.capabilityId}`);
        }
        visit(provider);
      }
      visiting.pop();
      visited.add(key);
      if (!record.active) plan.push(record);
    };
    visit(target);
    return plan;
  }

  private availableProviders(capabilityId: string): RegisteredModule[] {
    return [...this.registrations.values()]
      .filter((candidate) => {
        // Dependency validation is performed by buildActivationPlan so cycles
        // remain diagnosable as cycles rather than looking like a missing leaf.
        const status = candidate.capabilities.get(capabilityId)?.status;
        return status === 'available' || status === 'degraded';
      })
      .sort(
        (left, right) =>
          Number(right.active) - Number(left.active) ||
          compareUnicodeCodePoints(
            moduleKey(left.registration.manifest.id, left.registration.instanceId),
            moduleKey(right.registration.manifest.id, right.registration.instanceId),
          ),
      );
  }

  private effectiveCapabilityStatus(
    record: RegisteredModule,
    capabilityId: string,
    visiting: Set<string>,
    options: { activeOnly?: boolean } = {},
  ): AgentCapabilityStatus | undefined {
    const ownStatus = record.capabilities.get(capabilityId)?.status;
    if (ownStatus !== 'available' && ownStatus !== 'degraded') return ownStatus;
    const key = moduleKey(record.registration.manifest.id, record.registration.instanceId);
    if (visiting.has(key)) return 'unavailable';
    const nextVisiting = new Set(visiting).add(key);
    for (const dependency of record.registration.manifest.dependencies ?? []) {
      const externalSatisfied = [...this.externalProviders.values()].some(
        (provider) =>
          (options.activeOnly !== true || provider.active) &&
          provider.capabilities.some((candidate) => candidate.id === dependency.capabilityId) &&
          (provider.status === 'available' || provider.status === 'degraded'),
      );
      const satisfied =
        externalSatisfied ||
        [...this.registrations.values()].some((provider) => {
          if (options.activeOnly === true && !provider.active) return false;
          const status = this.effectiveCapabilityStatus(
            provider,
            dependency.capabilityId,
            nextVisiting,
            options,
          );
          return status === 'available' || status === 'degraded';
        });
      if (!satisfied) return 'unavailable';
    }
    return ownStatus;
  }

  private async resolveActivationGraph(
    target: RegisteredModule,
    visited = new Set<string>(),
    context: AgentCapabilityLifecycleContext = this.lifecycleContext,
  ): Promise<void> {
    context.signal.throwIfAborted();
    const key = moduleKey(target.registration.manifest.id, target.registration.instanceId);
    if (visited.has(key)) return;
    visited.add(key);
    await this.resolveRecord(target, context);
    for (const dependency of target.registration.manifest.dependencies ?? []) {
      if (this.hasActiveProvider(dependency.capabilityId)) continue;
      const candidates = [...this.registrations.values()]
        .filter((record) =>
          record.registration.manifest.capabilities.some(
            (capability) => capability.id === dependency.capabilityId,
          ),
        )
        .sort(
          (left, right) =>
            Number(right.active) - Number(left.active) ||
            compareUnicodeCodePoints(
              moduleKey(left.registration.manifest.id, left.registration.instanceId),
              moduleKey(right.registration.manifest.id, right.registration.instanceId),
            ),
        );
      let provider: RegisteredModule | undefined;
      for (const candidate of candidates) {
        context.signal.throwIfAborted();
        await this.resolveRecord(candidate, context);
        const availability = candidate.capabilities.get(dependency.capabilityId)?.status;
        if (availability === 'available' || availability === 'degraded') {
          provider = candidate;
          break;
        }
      }
      if (provider) await this.resolveActivationGraph(provider, visited, context);
    }
  }

  private async resolveRecord(
    record: RegisteredModule,
    context: AgentCapabilityLifecycleContext = this.lifecycleContext,
  ): Promise<void> {
    if (record.probeOperation) return await record.probeOperation;
    const operation = (async () => {
      try {
        context.signal.throwIfAborted();
        record.module = await this.loadModule(record, context);
        if (this.closing || this.closed || context.signal.aborted) return;
        const resolved = validateProbeResult(
          record.module.probe
            ? await invokeCapabilityLifecycle(() => record.module!.probe!(context))
            : { status: 'available' as const },
          record.registration.manifest.capabilities.map((capability) => capability.id),
        );
        if (this.closing || this.closed || context.signal.aborted) return;
        record.status = resolved.status;
        record.reason = resolved.reason;
        record.activation = resolved.activation;
        if (record.lastFailure?.operation === 'resolve') record.lastFailure = undefined;
        for (const declared of record.registration.manifest.capabilities) {
          record.capabilities.set(
            declared.id,
            resolved.capabilities?.[declared.id] ?? {
              status: resolved.status,
              ...(resolved.reason === undefined ? {} : { reason: resolved.reason }),
            },
          );
        }
      } catch (error) {
        if (this.closing || this.closed || context.signal.aborted) return;
        record.status = 'unavailable';
        record.reason = errorMessage(error);
        record.activation = undefined;
        record.lastFailure = { operation: 'resolve', message: record.reason };
        for (const declared of record.registration.manifest.capabilities) {
          record.capabilities.set(declared.id, {
            status: 'unavailable',
            reason: record.reason,
          });
        }
      }
      this.revision += 1;
    })();
    record.probeOperation = operation;
    try {
      await operation;
    } finally {
      if (record.probeOperation === operation) record.probeOperation = undefined;
    }
  }

  private requireRecord(moduleId: string, instanceId: string): RegisteredModule {
    const key = moduleKey(moduleId, instanceId);
    const record = this.registrations.get(key);
    if (!record) throw new Error(`Capability module is not registered: ${key}`);
    return record;
  }

  private async loadModule(
    record: RegisteredModule,
    context: AgentCapabilityLifecycleContext = this.lifecycleContext,
  ): Promise<AgentCapabilityModule> {
    if (record.module) return record.module;
    if (record.loadOperation) return await record.loadOperation;
    const operation = Promise.resolve()
      .then(() => {
        context.signal.throwIfAborted();
        return invokeCapabilityLifecycle(() => record.registration.load(context));
      })
      .then(validateModule);
    record.loadOperation = operation;
    try {
      record.module = await operation;
      return record.module;
    } finally {
      if (record.loadOperation === operation) record.loadOperation = undefined;
    }
  }
}

function moduleKey(moduleId: string, instanceId: string): string {
  return `${moduleId}\0${instanceId}`;
}

function moduleLabel(record: RegisteredModule): string {
  return `${record.registration.manifest.id} (${record.registration.instanceId})`;
}

function unavailableModuleError(record: RegisteredModule): Error {
  const reason = record.reason ?? 'Its external prerequisite is not ready.';
  return new Error(
    `Capability module is not available: ${moduleLabel(record)}. ${reason} ` +
      'Configure the prerequisite outside SchemaNaut and retry discovery.',
  );
}

function contributionOwner(moduleId: string, instanceId: string): string {
  return `module:${encodeURIComponent(moduleId)}:${encodeURIComponent(instanceId)}`;
}

function contributionIdentity(record: RegisteredModule, localId: string): string {
  return `${contributionOwner(
    record.registration.manifest.id,
    record.registration.instanceId,
  )}:${encodeURIComponent(localId)}`;
}

function errorMessage(error: unknown): string {
  return normalizeCapabilityDiagnostic(
    error instanceof Error ? error.message : String(error),
  ) ?? 'Capability lifecycle operation failed.';
}

async function invokeCapabilityLifecycle<T>(operation: () => T | Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw new Error(errorMessage(error));
  }
}

function cleanupFailure(record: RegisteredModule): string | undefined {
  if (record.disposeFailure !== undefined) return record.disposeFailure;
  const failures = [...record.pendingRetirements]
    .map((retirement) => retirement.diagnostic)
    .filter((message): message is string => message !== undefined);
  if (failures.length === 0) return undefined;
  if (failures.length === 1) return `Capability runtime retirement failed: ${failures[0]}`;
  return `Capability runtime retirements failed (${failures.length}): ${failures.join(' | ')}`;
}

function normalizeControlPlaneInteger(
  value: number,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function waitForShutdown(
  operation: Promise<void> | undefined,
  timeoutMs: number,
): Promise<void> {
  if (!operation) return Promise.reject(new Error('Capability shutdown was not started.'));
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new CapabilityShutdownTimeoutError(timeoutMs)), timeoutMs);
  });
  return Promise.race([operation, deadline]).finally(() => {
    if (timeout !== undefined) clearTimeout(timeout);
  });
}

function waitForTeardown(
  operation: Promise<void>,
  options: Readonly<{
    timeoutMs: number;
    target: string;
    controller: AbortController;
    onTimeout: (error: CapabilityTeardownTimeoutError) => void;
  }>,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      const error = new CapabilityTeardownTimeoutError(options.timeoutMs, options.target);
      options.onTimeout(error);
      if (!options.controller.signal.aborted) options.controller.abort(error);
      reject(error);
    }, options.timeoutMs);
  });
  return Promise.race([operation, deadline]).finally(() => {
    if (timeout !== undefined) clearTimeout(timeout);
  });
}

function wrapToolContributions(
  contributions: readonly ToolInvocationContribution[],
  lease: ModuleRuntimeLease,
): ToolInvocationContribution[] {
  return contributions.map((contribution) => ({
    definition: contribution.definition,
    runtime: Object.freeze({
      revision: Object.freeze({ ...contribution.runtime.revision }),
      prepare: bindInvocationHandlerIdentity(
        lease.wrapInvocationHandler(contribution.runtime.prepare),
        contribution.runtime.prepare,
      ),
      execute: bindInvocationHandlerIdentity(
        lease.wrapInvocationHandler(contribution.runtime.execute),
        contribution.runtime.execute,
      ),
      ...(contribution.runtime.recover === undefined
        ? {}
        : {
            recover: bindInvocationHandlerIdentity(
              lease.wrapInvocationHandler(contribution.runtime.recover),
              contribution.runtime.recover,
            ),
          }),
      ...(contribution.runtime.retainResult === undefined
        ? {}
        : {
            retainResult: bindInvocationHandlerIdentity(
              lease.wrapInvocationHandler(contribution.runtime.retainResult),
              contribution.runtime.retainResult,
            ),
          }),
    }),
  }));
}

function prepareContributions(
  record: RegisteredModule,
  runtime: AgentCapabilityModuleRuntime,
  lease: ModuleRuntimeLease,
): PreparedContributions {
  const contributions = runtime.contributions;
  const skillSources = uniqueContributions(
    requireContributionArray(contributions.skillSources, 'Module skillSources'),
    (item) => item.id,
    'Skill source',
  ).map((item) => {
    if (!['system', 'user', 'project', 'session'].includes(item.scope)) {
      throw new Error(`Invalid Skill source scope: ${String(item.scope)}`);
    }
    return {
      id: requireContributionText(item.id, 'Skill source id'),
      scope: item.scope,
      path: requireContributionText(item.path, `Skill source path (${item.id})`),
      revision: requireContributionText(item.revision, `Skill source revision (${item.id})`),
    };
  });
  const promptSections = uniqueContributions(
    requireContributionArray(contributions.promptSections, 'Module promptSections'),
    (item) => item.id,
    'Prompt section',
  ).map((section) => {
    if (section.source !== 'capability') {
      throw new Error(`Module Prompt section must use capability source: ${section.id}`);
    }
    return snapshotPromptSection({ ...section, id: contributionIdentity(record, section.id) });
  });
  const contextProviders = uniqueContributions(
    requireContributionArray(contributions.contextProviders, 'Module contextProviders'),
    (item) => item.id,
    'Context Provider',
  ).map((provider) => {
    const id = requireContributionText(provider.id, 'Context Provider id');
    const revision = requireContributionText(
      provider.revision,
      `Context Provider revision (${provider.id})`,
    );
    if (typeof provider.provide !== 'function') {
      throw new Error(`Context Provider must provide provide(): ${id}`);
    }
    const provide = lease.wrapContextProvider(provider.provide);
    return Object.freeze({
      id: contributionIdentity(record, id),
      revision,
      provide: async (input: AgentCapabilityContextRequest) => Object.freeze(
        (await provide(input)).map((section) => snapshotPromptSection({
          ...section,
          id: contributionIdentity(record, `${id}:${section.id}`),
        })),
      ),
    });
  });
  const services = uniqueContributions(
    requireContributionArray(contributions.services, 'Module services'),
    (item) => {
      if (!isRecord(item.token)) throw new Error('Capability service token is required.');
      return requireContributionText(item.token.id, 'Capability service token id');
    },
    'Capability service',
  ).map((item) => ({
    token: Object.freeze({
      id: requireContributionText(item.token.id, 'Capability service token id'),
    }),
    value: item.value,
  }));
  const declaredCapabilities = new Set(
    record.registration.manifest.capabilities.map((capability) => capability.id),
  );
  const stateReferences = uniqueContributions(
    requireContributionArray(contributions.stateReferences, 'Module stateReferences'),
    (item) => `${item.capabilityId}\0${item.stateId}`,
    'Capability state reference',
  ).map((item) => {
    const capabilityId = requireContributionText(item.capabilityId, 'State capability id');
    if (!declaredCapabilities.has(capabilityId)) {
      throw new Error(`Capability state references an undeclared capability: ${capabilityId}`);
    }
    return {
      capabilityId,
      stateId: requireContributionText(item.stateId, 'Capability state id'),
      version: requireContributionText(item.version, 'Capability state version'),
    };
  });
  const invocationHooks = uniqueContributions(
    requireContributionArray(contributions.invocationHooks, 'Module invocationHooks'),
    (item) => item.id,
    'Invocation Hook',
  ).map((hook) => {
    const id = requireContributionText(hook.id, 'Invocation Hook id');
    const revision = requireContributionText(hook.revision, `Invocation Hook revision (${id})`);
    if (hook.before === undefined && hook.after === undefined) {
      throw new Error(`Invocation Hook must provide before() or after(): ${id}`);
    }
    if (hook.before !== undefined && typeof hook.before !== 'function') {
      throw new Error(`Invocation Hook before must be a function: ${id}`);
    }
    if (hook.after !== undefined && typeof hook.after !== 'function') {
      throw new Error(`Invocation Hook after must be a function: ${id}`);
    }
    return Object.freeze({
      id: contributionIdentity(record, id),
      revision,
      ...(hook.before === undefined ? {} : { before: lease.wrapInvocationHandler(hook.before) }),
      ...(hook.after === undefined ? {} : { after: lease.wrapInvocationHandler(hook.after) }),
    });
  });
  return {
    tools: wrapToolContributions(
      requireContributionArray(contributions.tools, 'Module tools'),
      lease,
    ),
    skillSources,
    promptSections,
    contextProviders,
    services,
    stateReferences,
    invocationHooks,
  };
}

function requireContributionArray<T>(value: readonly T[] | undefined, label: string): readonly T[] {
  if (value === undefined) return [];
  const candidate: unknown = value;
  if (!Array.isArray(candidate)) throw new Error(`${label} must be an array.`);
  return value;
}

function uniqueContributions<T>(
  values: readonly T[],
  keyOf: (value: T) => string,
  label: string,
): T[] {
  const seen = new Set<string>();
  return values.map((value) => {
    if (!isRecord(value)) throw new Error(`${label} entry must be an object.`);
    const key = requireContributionText(keyOf(value), `${label} id`);
    if (seen.has(key)) throw new Error(`${label} is declared more than once: ${key}`);
    seen.add(key);
    return value;
  });
}

function requireContributionText(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function contributionSummary(
  contributions: PreparedContributions | undefined,
): AgentCapabilitySnapshot['modules'][number]['contributions'] {
  return {
    tools: contributions?.tools.length ?? 0,
    skillSources: contributions?.skillSources.length ?? 0,
    promptSections: contributions?.promptSections.length ?? 0,
    contextProviders: contributions?.contextProviders.length ?? 0,
    services: contributions?.services.length ?? 0,
    stateReferences: contributions?.stateReferences.length ?? 0,
    invocationHooks: contributions?.invocationHooks.length ?? 0,
  };
}

class ModuleRuntimeLease {
  private accepting = true;
  private shutdownRequested = false;
  private inFlight = 0;
  private snapshotPins = 0;
  private servicePins = 0;
  private drainWaiters: Array<() => void> = [];
  private readonly shutdownAbort = new AbortController();

  constructor(private readonly moduleKeyValue: string) {}

  wrapInvocationHandler<T extends (...args: never[]) => unknown>(handler: T): T {
    const wrapped = async (...args: Parameters<T>): Promise<Awaited<ReturnType<T>>> => {
      if (this.shutdownRequested) {
        throw new Error(`Capability module is shutting down: ${this.moduleKeyValue}`);
      }
      if (!this.accepting && this.snapshotPins === 0) {
        throw new Error(`Capability module is deactivating: ${this.moduleKeyValue}`);
      }
      this.inFlight += 1;
      try {
        return await handler(
          ...this.withShutdownSignal(args),
        ) as Awaited<ReturnType<T>>;
      } finally {
        this.inFlight -= 1;
        this.resolveDrainWaiters();
      }
    };
    return wrapped as T;
  }

  wrapContextProvider(
    provider: AgentCapabilityContextProviderContribution['provide'],
  ): AgentCapabilityContextProviderContribution['provide'] {
    return async (input) => {
      if (this.shutdownRequested) {
        throw new Error(`Capability module is shutting down: ${this.moduleKeyValue}`);
      }
      if (!this.accepting && this.snapshotPins === 0) {
        throw new Error(`Capability module is deactivating: ${this.moduleKeyValue}`);
      }
      this.inFlight += 1;
      try {
        assertContextRequest(input);
        const output: unknown = await provider(Object.freeze({
          ...input,
          signal: AbortSignal.any([input.signal, this.shutdownAbort.signal]),
        }));
        return snapshotContextProviderOutput(output, input.maxTokens);
      } finally {
        this.inFlight -= 1;
        this.resolveDrainWaiters();
      }
    };
  }

  retain(): () => void {
    if (!this.accepting || this.shutdownRequested) {
      throw new Error(`Capability module is deactivating: ${this.moduleKeyValue}`);
    }
    this.snapshotPins += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.shutdownRequested) return;
      this.snapshotPins -= 1;
      this.resolveDrainWaiters();
    };
  }

  retainService(): () => void {
    if (!this.accepting || this.shutdownRequested) {
      throw new Error(`Capability module is deactivating: ${this.moduleKeyValue}`);
    }
    this.servicePins += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.servicePins -= 1;
      this.resolveDrainWaiters();
    };
  }

  stopAccepting(): void {
    this.accepting = false;
  }

  stopForShutdown(): void {
    this.accepting = false;
    if (this.shutdownRequested) return;
    this.shutdownRequested = true;
    this.snapshotPins = 0;
    if (!this.shutdownAbort.signal.aborted) {
      this.shutdownAbort.abort(new Error(`Capability module is shutting down: ${this.moduleKeyValue}`));
    }
    this.resolveDrainWaiters();
  }

  drain(): Promise<void> {
    if (this.isDrained()) return Promise.resolve();
    return new Promise((resolve) => this.drainWaiters.push(resolve));
  }

  async drainWithin(timeoutMs: number): Promise<boolean> {
    if (this.isDrained()) return true;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let waiter: (() => void) | undefined;
    try {
      return await Promise.race([
        new Promise<boolean>((resolve) => {
          waiter = () => resolve(true);
          this.drainWaiters.push(waiter);
        }),
        new Promise<boolean>((resolve) => { timeout = setTimeout(() => resolve(false), timeoutMs); }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      if (waiter !== undefined) {
        const index = this.drainWaiters.indexOf(waiter);
        if (index >= 0) this.drainWaiters.splice(index, 1);
      }
    }
  }

  private resolveDrainWaiters(): void {
    if (!this.isDrained()) return;
    const waiters = this.drainWaiters;
    this.drainWaiters = [];
    for (const resolve of waiters) resolve();
  }

  private isDrained(): boolean {
    return this.inFlight === 0 && this.snapshotPins === 0 && this.servicePins === 0;
  }

  private withShutdownSignal<T extends readonly unknown[]>(args: T): T {
    const last = args.at(-1);
    if (!isRecord(last) || !(last.signal instanceof AbortSignal)) return args;
    const next = [...args];
    next[next.length - 1] = Object.freeze({
      ...last,
      signal: AbortSignal.any([last.signal, this.shutdownAbort.signal]),
    });
    return next as unknown as T;
  }
}

function assertContextRequest(input: unknown): asserts input is Parameters<
  AgentCapabilityContextProviderContribution['provide']
>[0] {
  if (!isRecord(input)) throw new Error('Context Provider request must be an object.');
  for (const field of ['projectId', 'sessionId', 'runId', 'turnId', 'query'] as const) {
    requireContributionText(input[field], `Context Provider request ${field}`);
  }
  if (!Number.isSafeInteger(input.maxTokens) || Number(input.maxTokens) < 0) {
    throw new Error('Context Provider request maxTokens must be a non-negative safe integer.');
  }
  if (!(input.signal instanceof AbortSignal)) {
    throw new Error('Context Provider request signal must be an AbortSignal.');
  }
}

function snapshotContextProviderOutput(
  value: unknown,
  maxTokens: number,
): readonly PromptSection[] {
  if (!Array.isArray(value)) throw new Error('Context Provider output must be an array.');
  if (value.length > 256) throw new Error('Context Provider output contains too many sections.');
  const sections: PromptSection[] = [];
  const seen = new Set<string>();
  let tokenEstimate = 0;
  for (const candidate of value) {
    if (!isRecord(candidate)) {
      throw new Error('Context Provider Prompt section must be an object.');
    }
    const section = snapshotPromptSection(candidate as PromptSection);
    if (section.source !== 'capability') {
      throw new Error(`Context Provider Prompt section must use capability source: ${section.id}`);
    }
    if (seen.has(section.id)) {
      throw new Error(`Context Provider Prompt section is declared more than once: ${section.id}`);
    }
    seen.add(section.id);
    tokenEstimate += section.tokenEstimate;
    if (tokenEstimate > maxTokens) {
      throw new Error('Context Provider output exceeds the requested token budget.');
    }
    sections.push(section);
  }
  return Object.freeze(sections);
}

function aggregateStatus(statuses: readonly AgentCapabilityStatus[]): AgentCapabilityStatus {
  if (statuses.includes('available')) return 'available';
  if (statuses.includes('degraded')) return 'degraded';
  if (statuses.includes('unavailable')) return 'unavailable';
  return 'disabled';
}

function validateModule(value: unknown): AgentCapabilityModule {
  if (!isRecord(value)) {
    throw new Error('Capability module loader must return a module object.');
  }
  if (typeof value.activate !== 'function') {
    throw new Error('Capability module must provide activate().');
  }
  if (value.probe !== undefined && typeof value.probe !== 'function') {
    throw new Error('Capability module probe must be a function.');
  }
  if (value.resolve !== undefined && typeof value.resolve !== 'function') {
    throw new Error('Capability module resolve must be a function.');
  }
  if (value.refresh !== undefined && typeof value.refresh !== 'function') {
    throw new Error('Capability module refresh must be a function.');
  }
  if (value.dispose !== undefined && typeof value.dispose !== 'function') {
    throw new Error('Capability module dispose must be a function.');
  }
  return value as AgentCapabilityModule;
}

function validateModuleRuntime(
  value: unknown,
  operation: 'activate' | 'refresh',
): AgentCapabilityModuleRuntime {
  if (!isRecord(value)) {
    throw new Error(`Capability module ${operation}() must return a runtime object.`);
  }
  if (!isRecord(value.contributions)) {
    throw new Error(`Capability module ${operation}() runtime must provide contributions.`);
  }
  const contributionKeys = [
    'tools', 'skillSources', 'promptSections', 'contextProviders',
    'services', 'stateReferences', 'invocationHooks',
  ];
  if (Object.keys(value.contributions).some((key) => !contributionKeys.includes(key))) {
    throw new Error('Capability module contributions contain unsupported fields.');
  }
  if (value.close !== undefined && typeof value.close !== 'function') {
    throw new Error(`Capability module ${operation}() runtime close must be a function.`);
  }
  for (const key of contributionKeys) {
    const contribution = value.contributions[key];
    if (Array.isArray(contribution) && !Object.isFrozen(contribution)) Object.freeze(contribution);
  }
  if (!Object.isFrozen(value.contributions)) Object.freeze(value.contributions);
  return Object.freeze(value) as AgentCapabilityModuleRuntime;
}

function validateProbeResult(
  value: unknown,
  declaredCapabilityIds: readonly string[],
): AgentCapabilityProbeResult {
  if (!isRecord(value)) {
    throw new Error('Capability module probe() must return a result object.');
  }
  const status = validateCapabilityStatus(value.status);
  const reason = optionalDiagnosticReason(value.reason, 'Capability probe reason');
  requireProbeReason(status, reason, 'Capability probe');
  let capabilities: Record<string, AgentCapabilityAvailability> | undefined;
  if (value.capabilities !== undefined) {
    if (!isRecord(value.capabilities)) {
      throw new Error('Capability probe capabilities must be an object.');
    }
    const declared = new Set(declaredCapabilityIds);
    capabilities = {};
    for (const [capabilityId, availability] of Object.entries(value.capabilities)) {
      if (!declared.has(capabilityId)) {
        throw new Error(`Capability probe returned an undeclared capability: ${capabilityId}`);
      }
      if (!isRecord(availability)) {
        throw new Error(`Capability probe availability must be an object: ${capabilityId}`);
      }
      const capabilityReason = optionalDiagnosticReason(
        availability.reason,
        `Capability probe reason (${capabilityId})`,
      );
      const capabilityStatus = validateCapabilityStatus(availability.status);
      requireProbeReason(
        capabilityStatus,
        capabilityReason,
        `Capability probe (${capabilityId})`,
      );
      capabilities[capabilityId] = {
        status: capabilityStatus,
        ...(capabilityReason === undefined ? {} : { reason: capabilityReason }),
      };
    }
  }
  const activation = value.activation === undefined
    ? undefined
    : validateExternalContextRequirement(value.activation);
  if (activation !== undefined && status !== 'available' && status !== 'degraded') {
    throw new Error('Capability choices require an available or degraded probe result.');
  }
  return {
    status,
    ...(reason === undefined ? {} : { reason }),
    ...(capabilities === undefined ? {} : { capabilities }),
    ...(activation === undefined ? {} : { activation }),
  };
}

function validateExternalContextRequirement(value: unknown): AgentCapabilityExternalContextRequirement {
  if (!isRecord(value)) throw new Error('Capability activation requirement must be an object.');
  const keys = Object.keys(value);
  if (
    keys.length !== 5 ||
    value.kind !== 'external_context' ||
    (value.selection !== 'automatic' && value.selection !== 'choice_required') ||
    !Object.hasOwn(value, 'providerId') ||
    !Object.hasOwn(value, 'probeRevision') ||
    !Object.hasOwn(value, 'candidates')
  ) {
    throw new Error('Capability activation requirement shape is invalid.');
  }
  const providerId = requireChoiceText(value.providerId, 'providerId', 256);
  const probeRevision = requireChoiceText(value.probeRevision, 'probeRevision', 256);
  if (!Array.isArray(value.candidates) || value.candidates.length < 1 || value.candidates.length > 20) {
    throw new Error('Capability external context candidates must contain 1-20 entries.');
  }
  if (
    value.selection === 'automatic' && value.candidates.length !== 1 ||
    value.selection === 'choice_required' && value.candidates.length < 2
  ) {
    throw new Error('Capability external context selection does not match its candidate count.');
  }
  const ids = new Set<string>();
  const candidates = value.candidates.map((candidateValue) => {
    if (!isRecord(candidateValue)) throw new Error('Capability choice candidate must be an object.');
    const candidateKeys = Object.keys(candidateValue);
    if (candidateKeys.some((key) => !['candidateId', 'label', 'description', 'metadata', 'fingerprint'].includes(key))) {
      throw new Error('Capability choice candidate contains unsupported fields.');
    }
    const candidateId = requireChoiceText(candidateValue.candidateId, 'candidateId', 256);
    if (ids.has(candidateId)) throw new Error('Capability choice candidate ids must be unique.');
    ids.add(candidateId);
    const label = requireChoiceText(candidateValue.label, 'candidate label', 256);
    const description = candidateValue.description === undefined
      ? undefined
      : requireChoiceText(candidateValue.description, 'candidate description', 512);
    const fingerprint = requireChoiceText(candidateValue.fingerprint, 'candidate fingerprint', 512);
    let metadata: Readonly<Record<string, string | number | boolean | null>> | undefined;
    if (candidateValue.metadata !== undefined) {
      if (!isRecord(candidateValue.metadata) || Object.keys(candidateValue.metadata).length > 16) {
        throw new Error('Capability choice candidate metadata must be a bounded object.');
      }
      const cloned = structuredClone(candidateValue.metadata);
      for (const [key, item] of Object.entries(cloned)) {
        requireChoiceText(key, 'candidate metadata key', 128);
        if (
          item !== null && typeof item !== 'string' && typeof item !== 'number' &&
          typeof item !== 'boolean'
        ) {
          throw new Error('Capability choice candidate metadata values must be scalar.');
        }
        if (typeof item === 'string' && item.length > 512) {
          throw new Error('Capability choice candidate metadata string is too long.');
        }
      }
      assertPortableValue(cloned);
      if (Buffer.byteLength(JSON.stringify(cloned), 'utf8') > 8 * 1024) {
        throw new Error('Capability choice candidate metadata exceeds its byte limit.');
      }
      metadata = cloned as Record<string, string | number | boolean | null>;
    }
    return Object.freeze({
      candidateId,
      label,
      ...(description === undefined ? {} : { description }),
      ...(metadata === undefined ? {} : { metadata }),
      fingerprint,
    });
  });
  return Object.freeze({
    kind: 'external_context',
    selection: value.selection,
    providerId,
    probeRevision,
    candidates,
  });
}

function requireChoiceText(
  value: unknown,
  label: string,
  maximum: number,
): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maximum) {
    throw new Error(`Capability choice ${label} is missing or exceeds ${maximum} characters.`);
  }
  return value.trim();
}

function validateActivationBinding(
  record: RegisteredModule,
  value: AgentCapabilityActivationBinding | undefined,
): AgentCapabilityActivationBinding | undefined {
  const requirement = record.activation;
  if (requirement === undefined) {
    if (value !== undefined) throw new Error('Capability does not accept an external choice binding.');
    return undefined;
  }
  if (value === undefined) throw new Error('Capability activation requires a Runtime choice binding.');
  if (Object.keys(value).some((key) =>
    !['providerId', 'candidateId', 'fingerprint', 'capabilityGeneration'].includes(key))) {
    throw new Error('Capability activation binding shape is invalid.');
  }
  const providerId = requireChoiceText(value.providerId, 'binding providerId', 256);
  const candidateId = requireChoiceText(value.candidateId, 'binding candidateId', 256);
  const fingerprint = requireChoiceText(value.fingerprint, 'binding fingerprint', 512);
  const candidate = requirement.candidates.find((entry) => entry.candidateId === candidateId);
  if (
    providerId !== requirement.providerId ||
    candidate === undefined ||
    candidate.fingerprint !== fingerprint
  ) {
    throw new Error('Capability activation binding is stale for the current probe generation.');
  }
  const capabilityGeneration = capabilityBindingGeneration(record, requirement, candidateId, fingerprint);
  if (value.capabilityGeneration !== capabilityGeneration) {
    throw new Error('Capability activation binding generation is invalid.');
  }
  return Object.freeze({ providerId, candidateId, fingerprint, capabilityGeneration });
}

function capabilityBindingGeneration(
  record: RegisteredModule,
  requirement: AgentCapabilityExternalContextRequirement,
  candidateId: string,
  fingerprint: string,
): string {
  return `capability-binding.v1.${createHash('sha256').update(JSON.stringify({
    moduleId: record.registration.manifest.id,
    moduleVersion: record.registration.manifest.version,
    instanceId: record.registration.instanceId,
    providerId: requirement.providerId,
    probeRevision: requirement.probeRevision,
    candidateId,
    fingerprint,
  })).digest('hex')}`;
}

function sameActivationBinding(
  left: AgentCapabilityActivationBinding | undefined,
  right: AgentCapabilityActivationBinding | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.providerId === right.providerId &&
    left.candidateId === right.candidateId &&
    left.fingerprint === right.fingerprint &&
    left.capabilityGeneration === right.capabilityGeneration;
}

function validateCapabilityStatus(value: unknown): AgentCapabilityStatus {
  if (
    value !== 'available' &&
    value !== 'unloaded' &&
    value !== 'unavailable' &&
    value !== 'degraded' &&
    value !== 'disabled'
  ) {
    throw new Error(`Invalid capability status: ${String(value)}`);
  }
  return value;
}

function optionalDiagnosticReason(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`);
  return normalizeCapabilityDiagnostic(value);
}

function normalizeCapabilityDiagnostic(value: string): string | undefined {
  const normalized = Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) ? ' ' : character;
  }).join('').replace(/\s+/gu, ' ').trim().slice(0, 2_048);
  return normalized || undefined;
}

function requireProbeReason(
  status: AgentCapabilityStatus,
  reason: string | undefined,
  label: string,
): void {
  if ((status === 'unavailable' || status === 'degraded') && reason === undefined) {
    throw new Error(`${label} must explain an ${status} status.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateAndCloneRegistration(
  registration: AgentCapabilityModuleRegistration,
): AgentCapabilityModuleRegistration {
  if (!isRecord(registration)) {
    throw new Error('Capability module registration must be an object.');
  }
  if (!isRecord(registration.manifest)) {
    throw new Error('Capability module manifest must be an object.');
  }
  if (!Array.isArray(registration.manifest.capabilities)) {
    throw new Error('Capability module capabilities must be an array.');
  }
  if (Object.hasOwn(registration, 'enabled')) {
    throw new Error('Capability module registration does not support enabled.');
  }
  if (typeof registration.load !== 'function') {
    throw new Error('Capability module loader must be a function.');
  }
  if (registration.dispose !== undefined && typeof registration.dispose !== 'function') {
    throw new Error('Capability module registration disposer must be a function.');
  }
  const moduleId = requireIdentifier(registration.manifest.id, 'Module id');
  const instanceId = requireIdentifier(registration.instanceId, 'Module instance id');
  const version = requireIdentifier(registration.manifest.version, 'Module version');
  const description = requireContributionText(
    registration.manifest.description,
    'Module description',
  );
  const capabilityIds = new Set<string>();
  const capabilities = registration.manifest.capabilities.map((capability) => {
    if (!isRecord(capability)) throw new Error('Capability declaration must be an object.');
    const id = requireIdentifier(capability.id, 'Capability id');
    if (capabilityIds.has(id)) throw new Error(`Capability is declared more than once: ${id}`);
    capabilityIds.add(id);
    const capabilityDescription = requireContributionText(
      capability.description,
      `Capability description (${id})`,
    );
    return { id, description: capabilityDescription };
  });
  if (capabilities.length === 0) {
    throw new Error('Capability module must declare at least one capability.');
  }
  if (
    registration.manifest.dependencies !== undefined &&
    !Array.isArray(registration.manifest.dependencies)
  ) {
    throw new Error('Capability module dependencies must be an array.');
  }
  const dependencyIds = new Set<string>();
  const dependencies = registration.manifest.dependencies?.map((dependency) => {
    if (!isRecord(dependency)) throw new Error('Capability dependency must be an object.');
    const capabilityId = requireIdentifier(dependency.capabilityId, 'Capability dependency id');
    if (capabilityIds.has(capabilityId)) {
      throw new Error(`Module cannot require its own capability: ${capabilityId}`);
    }
    if (dependencyIds.has(capabilityId)) {
      throw new Error(`Capability dependency is declared more than once: ${capabilityId}`);
    }
    dependencyIds.add(capabilityId);
    return { capabilityId };
  });
  return {
    manifest: {
      id: moduleId,
      version,
      description,
      capabilities,
      ...(dependencies === undefined ? {} : { dependencies }),
    },
    instanceId,
    load: registration.load,
    ...(registration.dispose === undefined ? {} : { dispose: registration.dispose }),
  };
}

function validateAndCloneExternalProvider(
  provider: AgentExternalCapabilityProvider,
): AgentExternalCapabilityProvider {
  if (!isRecord(provider)) {
    throw new Error('External capability provider must be an object.');
  }
  if (!Array.isArray(provider.capabilities)) {
    throw new Error('External capability provider capabilities must be an array.');
  }
  if (typeof provider.active !== 'boolean') {
    throw new Error('External capability provider active must be a boolean.');
  }
  const providerId = requireIdentifier(provider.providerId, 'External capability provider id');
  const description = requireContributionText(
    provider.description,
    'External capability provider description',
  );
  const status = validateCapabilityStatus(provider.status);
  const reason = optionalDiagnosticReason(provider.reason, 'External capability provider reason');
  const seen = new Set<string>();
  const capabilities = provider.capabilities.map((capability) => {
    if (!isRecord(capability)) throw new Error('Capability declaration must be an object.');
    const id = requireIdentifier(capability.id, 'Capability id');
    if (seen.has(id)) throw new Error(`Capability is declared more than once: ${id}`);
    seen.add(id);
    const capabilityDescription = requireContributionText(
      capability.description,
      `Capability description (${id})`,
    );
    return { id, description: capabilityDescription };
  });
  if (capabilities.length === 0) {
    throw new Error('External capability provider must declare at least one capability.');
  }
  return {
    providerId,
    description,
    capabilities,
    status,
    active: provider.active,
    ...(reason === undefined ? {} : { reason }),
  };
}

function runtimeSnapshotIdentity(input: Readonly<{
  capabilities: AgentCapabilitySnapshot;
  tools: ReturnType<ToolRegistry['captureSnapshot']>;
  skillSources: readonly AgentCapabilitySkillSourceContribution[];
  promptSections: readonly PromptSection[];
  contextProviders: readonly AgentCapabilityContextProviderContribution[];
  invocationHooks: readonly AgentInvocationHookContribution[];
  stateReferences: readonly AgentCapabilityStateReference[];
}>): Readonly<{ snapshotId: string; revision: string }> {
  const tools = input.tools.listDescriptors()
    .map((descriptor) => {
      const invocationRevision = input.tools.invocationRevision(descriptor.flatName);
      if (invocationRevision === undefined) {
        throw new Error(
          `Capability Runtime Snapshot cannot capture a legacy Tool: ${descriptor.flatName}`,
        );
      }
      return { descriptor, invocationRevision };
    })
    .sort((left, right) => compareUnicodeCodePoints(left.descriptor.flatName, right.descriptor.flatName));
  const payload = toPortableValue({
    schemaVersion: 1,
    modules: input.capabilities.modules
      .filter((module) => module.active)
      .map((module) => ({
        moduleId: module.moduleId,
        instanceId: module.instanceId,
        version: module.version,
        capabilities: module.capabilities.map((capability) => ({
          capabilityId: capability.capabilityId,
          status: capability.status,
        })),
      })),
    externalProviders: input.capabilities.externalProviders
      .filter((provider) => provider.active)
      .map((provider) => ({
        providerId: provider.providerId,
        status: provider.status,
        capabilities: provider.capabilities.map((capability) => ({
          capabilityId: capability.capabilityId,
          status: capability.status,
        })),
      })),
    tools,
    skillSources: [...input.skillSources]
      .map((source) => ({
        id: source.id,
        scope: source.scope,
        path: source.path,
        revision: source.revision,
      }))
      .sort((left, right) => compareUnicodeCodePoints(left.id, right.id)),
    promptSections: [...input.promptSections]
      .map((section) => structuredClone(section))
      .sort((left, right) => compareUnicodeCodePoints(left.id, right.id)),
    contextProviders: [...input.contextProviders]
      .map((provider) => ({ id: provider.id, revision: provider.revision }))
      .sort(compareIdentity),
    invocationHooks: [...input.invocationHooks]
      .map((hook) => ({ id: hook.id, revision: hook.revision }))
      .sort(compareIdentity),
    stateReferences: [...input.stateReferences]
      .map((reference) => structuredClone(reference))
      .sort((left, right) =>
        compareUnicodeCodePoints(
          `${left.moduleId}\0${left.instanceId}\0${left.capabilityId}\0${left.stateId}`,
          `${right.moduleId}\0${right.instanceId}\0${right.capabilityId}\0${right.stateId}`,
        )),
  });
  const digest = createHash('sha256').update(canonicalPortableJson(payload)).digest('hex');
  return Object.freeze({
    snapshotId: `capability:${digest}`,
    revision: `sha256:${digest}`,
  });
}

function compareIdentity(
  left: Readonly<{ id: string; revision: string }>,
  right: Readonly<{ id: string; revision: string }>,
): number {
  return compareUnicodeCodePoints(
    `${left.id}\0${left.revision}`,
    `${right.id}\0${right.revision}`,
  );
}

function canonicalPortableJson(value: PortableValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalPortableJson).join(',')}]`;
  const record = value as { [key: string]: PortableValue };
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalPortableJson(record[key] ?? null)}`
  ).join(',')}}`;
}

function requireIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}
