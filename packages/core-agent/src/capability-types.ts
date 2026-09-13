import type { AgentCapabilityStateReference } from './types.js';
import type { PromptSection } from './context/prompt-runtime.js';
import type {
  ToolCatalogSnapshot,
  ToolInvocationAuthorization,
  ToolInvocationContribution,
} from './tool-registry.js';
import type { AgentToolDescriptor } from './types.js';

export type AgentInvocationHookInput = Readonly<{
  projectId: string;
  sessionId: string;
  runId: string;
  turnId: string;
  invocationId: string;
  tool: Readonly<AgentToolDescriptor>;
  arguments: Readonly<Record<string, unknown>>;
  authorization: ToolInvocationAuthorization;
  signal: AbortSignal;
}>;

export type AgentInvocationHookAfterInput = AgentInvocationHookInput & Readonly<{
  outcome: 'succeeded' | 'failed' | 'cancelled' | 'unknown' | 'timed_out' | 'unsupported_revision';
  summary: string;
}>;

/** Revisioned, observation-only policy around the unique Invocation boundary. */
export type AgentInvocationHookContribution = Readonly<{
  id: string;
  revision: string;
  before?(input: AgentInvocationHookInput):
    | void
    | Readonly<{ reject: string }>
    | Promise<void | Readonly<{ reject: string }>>;
  after?(input: AgentInvocationHookAfterInput): void | Promise<void>;
}>;

export type AgentCapabilityStatus =
  | 'unloaded'
  | 'available'
  | 'unavailable'
  | 'degraded'
  | 'disabled';

export type AgentCapabilityDefinition = {
  id: string;
  description: string;
};

export type AgentCapabilityRequirement = {
  capabilityId: string;
};

export type AgentCapabilityModuleManifest = {
  id: string;
  version: string;
  description: string;
  capabilities: readonly AgentCapabilityDefinition[];
  dependencies?: readonly AgentCapabilityRequirement[];
};

/** A trusted host target; it is never included in model-visible discovery output. */
export type AgentCapabilityDiscoveryTarget = Readonly<{
  moduleId: string;
  instanceId: string;
}>;

/** Static semantic manifest captured without invoking a module loader. */
export type AgentCapabilityDiscoveryManifestEntry = Readonly<{
  name: string;
  description: string;
  status: AgentCapabilityStatus;
  /** Bounded explanation of a probed availability result. */
  reason?: string;
  target: AgentCapabilityDiscoveryTarget;
  activation?: AgentCapabilityExternalContextRequirement;
}>;

export type AgentCapabilityAvailability = {
  status: AgentCapabilityStatus;
  reason?: string;
};

export type AgentCapabilityProbeResult = AgentCapabilityAvailability & {
  capabilities?: Readonly<Record<string, AgentCapabilityAvailability>>;
  activation?: AgentCapabilityExternalContextRequirement;
};

export type AgentCapabilityProbeChoice = Readonly<{
  candidateId: string;
  label: string;
  description?: string;
  /** Bounded scalar metadata captured from the external probe. */
  metadata?: Readonly<Record<string, string | number | boolean | null>>;
  /** Stable identity used to detect an externally changed context. */
  fingerprint: string;
  /** Runtime-issued opaque reference, present only in a captured Turn manifest. */
  probeChoiceRef?: string;
}>;

export type AgentCapabilityExternalContextRequirement = Readonly<{
  kind: 'external_context';
  selection: 'automatic' | 'choice_required';
  providerId: string;
  probeRevision: string;
  candidates: readonly AgentCapabilityProbeChoice[];
}>;

export type AgentCapabilityActivationBinding = Readonly<{
  providerId: string;
  candidateId: string;
  fingerprint: string;
  capabilityGeneration: string;
}>;

export type AgentCapabilitySkillSourceContribution = {
  id: string;
  scope: 'system' | 'user' | 'project' | 'session';
  path: string;
  /** Stable source revision captured with the complete module generation. */
  revision: string;
};

export type AgentCapabilityContextRequest = Readonly<{
  projectId: string;
  sessionId: string;
  runId: string;
  turnId: string;
  query: string;
  maxTokens: number;
  signal: AbortSignal;
}>;

export type AgentCapabilityContextProviderContribution = Readonly<{
  id: string;
  revision: string;
  provide(input: AgentCapabilityContextRequest):
    | readonly PromptSection[]
    | Promise<readonly PromptSection[]>;
}>;

export type AgentCapabilityServiceToken<T> = {
  readonly id: string;
  /** Type-only service-shape marker; it does not exist at runtime. */
  readonly __serviceType?: T;
};

export function createAgentCapabilityServiceToken<T>(id: string): AgentCapabilityServiceToken<T> {
  const normalized = id.trim();
  if (!normalized) throw new Error('Capability service token id is required.');
  return Object.freeze({ id: normalized });
}

export type AgentCapabilityServiceContribution<T = unknown> = {
  token: AgentCapabilityServiceToken<T>;
  value: T;
};

export type AgentCapabilityStateContribution = {
  capabilityId: string;
  stateId: string;
  version: string;
};

export type AgentCapabilityModuleContributions = Readonly<{
  tools?: readonly ToolInvocationContribution[];
  skillSources?: readonly AgentCapabilitySkillSourceContribution[];
  promptSections?: readonly PromptSection[];
  contextProviders?: readonly AgentCapabilityContextProviderContribution[];
  services?: readonly AgentCapabilityServiceContribution[];
  stateReferences?: readonly AgentCapabilityStateContribution[];
  invocationHooks?: readonly AgentInvocationHookContribution[];
}>;

/**
 * One immutable generation. A refresh must return a distinct generation.
 * Generation close owns only generation-scoped resources; reusable pools or
 * other shared state belong to the module and are released by module.dispose().
 */
export type AgentCapabilityModuleRuntime = Readonly<{
  contributions: AgentCapabilityModuleContributions;
  /**
   * Release resources owned by this immutable runtime generation. The host
   * supplies a teardown signal that is distinct from the construction signal.
   * Shared module-wide resources must instead be released by module.dispose().
   */
  close?: (context?: AgentCapabilityTeardownContext) => void | Promise<void>;
}>;

/**
 * Cooperative cancellation owned by the host for module discovery and
 * generation construction. A module must treat an aborted signal as a request
 * to stop work; the control plane still fences publication independently.
 */
export type AgentCapabilityLifecycleContext = Readonly<{
  signal: AbortSignal;
  /** Absolute ISO deadline when lifecycle work belongs to a Tool invocation. */
  deadline?: string;
}>;

/** Cooperative cancellation for generation and module teardown attempts. */
export type AgentCapabilityTeardownContext = Readonly<{
  signal: AbortSignal;
}>;

export type AgentCapabilityModule = {
  probe?: (
    context?: AgentCapabilityLifecycleContext,
  ) => AgentCapabilityProbeResult | Promise<AgentCapabilityProbeResult>;
  activate: (
    context?: AgentCapabilityLifecycleContext,
  ) => AgentCapabilityModuleRuntime | Promise<AgentCapabilityModuleRuntime>;
  /** Resolve one Runtime-validated external choice without storing configuration. */
  resolve?: (
    candidateId: string,
    context?: AgentCapabilityLifecycleContext,
  ) => AgentCapabilityModuleRuntime | Promise<AgentCapabilityModuleRuntime>;
  refresh?: (
    current: AgentCapabilityModuleRuntime,
    context?: AgentCapabilityLifecycleContext,
  ) => AgentCapabilityModuleRuntime | Promise<AgentCapabilityModuleRuntime>;
  /** Release module-wide resources once every owned generation has closed. */
  dispose?: (context?: AgentCapabilityTeardownContext) => void | Promise<void>;
};

export type AgentCapabilityModuleRegistration = {
  manifest: AgentCapabilityModuleManifest;
  instanceId: string;
  load: (
    context?: AgentCapabilityLifecycleContext,
  ) => AgentCapabilityModule | Promise<AgentCapabilityModule>;
  /**
   * Release resources owned by the registration itself when the module was
   * never loaded. Loaded modules use AgentCapabilityModule.dispose instead.
   */
  dispose?: (context?: AgentCapabilityTeardownContext) => void | Promise<void>;
};

export type AgentCapabilityModuleSnapshot = {
  moduleId: string;
  instanceId: string;
  version: string;
  description: string;
  status: AgentCapabilityStatus;
  active: boolean;
  /** True while this module still owns lifecycle work during host shutdown. */
  draining: boolean;
  reason?: string;
  lastFailure?: AgentCapabilityLifecycleFailure;
  capabilities: readonly AgentCapabilityProviderSnapshot[];
  contributions: AgentCapabilityContributionSummary;
};

export type AgentCapabilityLifecycleFailure = {
  operation: 'resolve' | 'activate' | 'refresh' | 'deactivate' | 'dispose';
  message: string;
};

export type AgentCapabilityContributionSummary = {
  tools: number;
  skillSources: number;
  promptSections: number;
  contextProviders: number;
  services: number;
  stateReferences: number;
  invocationHooks: number;
};

export type AgentCapabilityServiceSelector = {
  moduleId: string;
  instanceId: string;
};

export type AgentCapabilityServiceLease<T> = {
  moduleId: string;
  instanceId: string;
  value: T;
  release: () => void;
};

export type AgentCapabilityProviderSnapshot = {
  capabilityId: string;
  status: AgentCapabilityStatus;
  reason?: string;
};

export type AgentCapabilityAggregateSnapshot = {
  capabilityId: string;
  status: AgentCapabilityStatus;
};

export type AgentExternalCapabilityProvider = {
  providerId: string;
  description: string;
  capabilities: readonly AgentCapabilityDefinition[];
  status: AgentCapabilityStatus;
  active: boolean;
  reason?: string;
};

export type AgentExternalCapabilityProviderSnapshot = {
  providerId: string;
  description: string;
  status: AgentCapabilityStatus;
  active: boolean;
  reason?: string;
  capabilities: readonly AgentCapabilityProviderSnapshot[];
};

export type AgentCapabilitySnapshot = {
  revision: number;
  /** Host lifecycle, distinct from whether any individual module is active. */
  phase: 'running' | 'closing' | 'draining' | 'closed';
  modules: readonly AgentCapabilityModuleSnapshot[];
  externalProviders: readonly AgentExternalCapabilityProviderSnapshot[];
  capabilities: readonly AgentCapabilityAggregateSnapshot[];
};

export type AgentCapabilityRuntimeSnapshotIdentity = Readonly<{
  /** Content-addressed identity of the complete executable contribution generation. */
  snapshotId: string;
  /** Portable revision stored in each Turn Snapshot and resolved after restart. */
  revision: string;
}>;

/**
 * One immutable view of every capability contribution consumed by an Agent
 * iteration. Releasing the view allows retired module generations to drain.
 */
export type AgentCapabilityRuntimeSnapshot = {
  identity: AgentCapabilityRuntimeSnapshotIdentity;
  capabilities: AgentCapabilitySnapshot;
  tools: ToolCatalogSnapshot;
  skillSources: readonly AgentCapabilitySkillSourceContribution[];
  promptSections: readonly PromptSection[];
  contextProviders: readonly AgentCapabilityContextProviderContribution[];
  invocationHooks: readonly AgentInvocationHookContribution[];
  stateReferences: readonly AgentCapabilityStateReference[];
  release: () => void;
};
