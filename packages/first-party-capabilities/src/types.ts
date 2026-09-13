import type { AgentCapabilityModuleRegistration, AgentToolPermissionFacts, ToolInvocationContribution } from '@dbagent/core-agent';
import type { CapabilityCommandRuntime, ExecutableDiscoveryResult, ProcessPathTarget } from '@dbagent/core-tools';

/** Host-owned interfaces. This package neither stores configuration nor launches processes. */
export type FirstPartyCapabilityHost = Readonly<{
  workspaceRoot: string;
  command: CapabilityCommandRuntime;
  executables: Readonly<{ discover(name: string): Promise<ExecutableDiscoveryResult> }>;
}>;
export type CommandCapabilityOperation = Readonly<{
  name: string; description: string; inputSchema: Readonly<Record<string, unknown>>;
  argv(input: Readonly<Record<string, unknown>>, provider: string): readonly string[];
  /** Only contribute this operation for the selected, statically discovered CLI provider. */
  providers?: readonly string[];
  pathInputs?(input: Readonly<Record<string, unknown>>): readonly string[];
  /** Fixed semantic external targets, for example a local container daemon socket. */
  hostTargets?: readonly string[];
  permission: Pick<AgentToolPermissionFacts, 'access' | 'recoveryClass' | 'dangerLevel' | 'actions'> & Readonly<{ network: boolean; externalWrite: boolean; destructive: boolean; admin: boolean; unknownRisk: boolean }>;
  output: 'stable-text' | 'json';
  /** Some status-oriented CLIs return a non-zero code with valid JSON data. */
  allowNonZeroJson?: boolean;
}>;
export type CommandCapabilitySpec = Readonly<{
  moduleId: string; capabilityId: string; instanceId: string; version: string; description: string;
  executables: readonly string[]; selection?: 'automatic' | 'choice_required';
  /** A partially installed multi-client capability can remain usable but degraded. */
  degradeWhenPartialAvailability?: boolean;
  operations: readonly CommandCapabilityOperation[];
}>;
export type FirstPartyCapabilityRegistration = AgentCapabilityModuleRegistration;
export type FirstPartyCommandContribution = ToolInvocationContribution;
export type PreparedCommandPath = ProcessPathTarget;
