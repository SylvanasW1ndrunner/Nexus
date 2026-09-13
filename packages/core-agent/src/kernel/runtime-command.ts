import type { PortableValue } from '@dbagent/shared';
import type { AgentCapabilityActivationBinding } from '../capability-types.js';
import type { AgentEvent } from '../events/agent-event.js';
import type { KernelRunProjection } from './run-controller.js';

export type RuntimeCommandOrigin = Readonly<{
  runId: string;
  turnId: string;
  invocationId: string;
}>;

/** Host-only module instance selected from the semantic discovery manifest. */
export type RuntimeCapabilityDiscoveryTarget = Readonly<{
  moduleId: string;
  instanceId: string;
}>;

/** Exact deferred Tool generation selected from one immutable Turn catalog. */
export type RuntimeToolActivation = Readonly<{
  name: string;
  toolRevision: string;
  handlerRevision: string;
}>;

export type RuntimeCapabilityActivationBinding = Readonly<{
  target: RuntimeCapabilityDiscoveryTarget;
  binding: AgentCapabilityActivationBinding;
}>;

/**
 * Trusted, portable exact Skill identity. It is durable Run state only and
 * never projected into a model-visible catalog or Tool observation.
 */
export type RuntimeSkillActivation = {
  id: string;
  revision: {
    schemaVersion: 1;
    revisionId: string;
    scope: 'system' | 'user' | 'project' | 'session';
    sourceId: string;
    sourcePath: string;
    bundleRoot: string;
    sourceOrder: number;
    name: string;
    contentDigest: string;
    bundleDigest: string;
  };
  allowedTools?: string[];
};

type RuntimeCommandBase<K extends string, P extends PortableValue> = Readonly<{
  schemaVersion: 2;
  kind: K;
  commandId: string;
  origin: RuntimeCommandOrigin;
  expectedRunRevision: number;
  fencingToken: number;
  payload: P;
}>;

export type RuntimeCommand =
  | RuntimeCommandBase<'plan.create', { planId: string; plan: PortableValue }>
  | RuntimeCommandBase<'plan.update', { planId: string; expectedPlanRevision: number; plan: PortableValue }>
  | RuntimeCommandBase<'discovery.activate', {
      tools: RuntimeToolActivation[];
      targets: RuntimeCapabilityDiscoveryTarget[];
      bindings: RuntimeCapabilityActivationBinding[];
    }>
  | RuntimeCommandBase<'skill.activate', { activations: RuntimeSkillActivation[] }>
  | RuntimeCommandBase<'child.start', { task: string; context: PortableValue }>
  | RuntimeCommandBase<'child.list', Record<string, never>>
  | RuntimeCommandBase<'child.wait', {
      childRunId: string;
      expectedChildRevision: number;
    }>
  | RuntimeCommandBase<'child.steer', {
      childRunId: string;
      expectedChildRevision: number;
      input: PortableValue;
    }>
  | RuntimeCommandBase<'child.cancel', {
      childRunId: string;
      expectedChildRevision: number;
      reason?: string;
    }>;

export type RuntimeCommandInput = RuntimeCommand;

export type RuntimeCommandChildProjection = Readonly<{
  childRunId: string;
  childSessionId: string;
  parentRunId: string;
  parentInvocationId: string;
  /** Present for v2 child.start facts; absent only on pre-Task16 projections. */
  startCommandId?: string;
  revision: number;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'limit_reached' | 'interrupted';
  task: string;
  context: PortableValue;
  lastInput?: PortableValue;
  reason?: string;
}>;

export type RuntimeCommandProjection = Readonly<{
  schemaVersion: 2;
  projectId: string;
  sessionId: string;
  runId: string;
  revision: number;
  plan: null | Readonly<{
    planId: string;
    revision: number;
    plan: PortableValue;
  }>;
  activeTools: readonly RuntimeToolActivation[];
  /** Trusted host targets; never returned in a model-visible Tool result. */
  discoveredCapabilities: readonly RuntimeCapabilityDiscoveryTarget[];
  activationBindings: readonly RuntimeCapabilityActivationBinding[];
  activeSkills: readonly RuntimeSkillActivation[];
  children: readonly RuntimeCommandChildProjection[];
}>;

export type RuntimeCommandApplicationResult = Readonly<{
  events: readonly AgentEvent[];
  run: KernelRunProjection;
  projection: RuntimeCommandProjection;
}>;

export class RuntimeCommandError extends Error {
  constructor(
    readonly code: 'RUNTIME_COMMAND_INVALID' | 'RUNTIME_COMMAND_UNAUTHENTIC',
    message: string,
  ) {
    super(message);
    this.name = 'RuntimeCommandError';
  }
}
// Deliberately separate from RuntimeCommand: only Host ingress can submit answers.
export type { QuestionRuntimeCommand } from '../tools/tool-question.js';
