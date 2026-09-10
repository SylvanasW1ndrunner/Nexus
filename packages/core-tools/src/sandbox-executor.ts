import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AgentMode } from '@dbagent/core-agent';
import type { ExecutableLaunchDescriptor } from './executable-discovery.js';

export type ProcessLaunch = Readonly<{ kind: 'shell'; command: string }> | Readonly<{ kind: 'argv'; executable: ExecutableLaunchDescriptor; argv: readonly string[] }>;

export type ProcessRequestedCapabilities = Readonly<{ network: boolean; externalWrite: boolean; destructive: boolean; credentials: boolean; admin: boolean; unknownRisk: boolean }>;
export type SandboxCapabilityMatrix = Readonly<{ filesystem: boolean; network: boolean; processTree: boolean }>;
export type SandboxExecutorIdentity = Readonly<{ hostId: string; executorId: string; executorRevision: string; boundaryRevision: string; capabilities: SandboxCapabilityMatrix }>;
export type ProcessGlobalPolicy = Readonly<{
  revision: string;
  mode: AgentMode;
  requireSandbox?: boolean;
  removeEnvironmentVariables?: readonly string[];
  /** Global Host enterprise gate; never supplied by a model or project config. */
  allowCommand?: (command: string) => boolean;
}>;
export type SandboxDecision = 'sandboxed-allow' | 'ask' | 'ask-unsandboxed' | 'native-allow' | 'unavailable';
export type PreparedSandboxBoundary = SandboxExecutorIdentity & Readonly<{
  policyRevision: string; mode: AgentMode; requested: ProcessRequestedCapabilities; decision: SandboxDecision;
}>;
export type SandboxSpawnInput = Readonly<{
  launch: ProcessLaunch; cwd: string; environment: NodeJS.ProcessEnv;
  boundary: PreparedSandboxBoundary; signal: AbortSignal;
}>;
export interface SandboxExecutor {
  readonly identity: SandboxExecutorIdentity;
  /** Native Windows can report root exit without claiming descendant proof. */
  readonly naturalExitTreeProof?: 'unverified' | undefined;
  /** Must synchronously bind the child to exactly the declared boundary. No fallback. */
  spawn(input: SandboxSpawnInput): ChildProcessWithoutNullStreams;
  /** Resolves only after the root and tracked descendants are confirmed stopped. */
  terminate(child: ChildProcessWithoutNullStreams, context: { signal: AbortSignal; deadline: string }): Promise<void>;
  /** Proof after natural root close; absence of this hook is NOT tree-stop proof. */
  confirmExit?(child: ChildProcessWithoutNullStreams, context: { signal: AbortSignal; deadline: string }): Promise<void>;
}

export function prepareSandboxBoundary(identity: SandboxExecutorIdentity, policy: ProcessGlobalPolicy, requested: ProcessRequestedCapabilities): PreparedSandboxBoundary {
  for (const value of [identity.hostId, identity.executorId, identity.executorRevision, identity.boundaryRevision, policy.revision]) if (typeof value !== 'string' || !value.trim() || value.length > 128) throw new TypeError('Invalid process executor/policy identity.');
  if (!['default', 'auto', 'full-access'].includes(policy.mode)) throw new TypeError('Invalid global process permission mode.');
  const strong = identity.capabilities.filesystem && identity.capabilities.network && identity.capabilities.processTree;
  const risky = requested.destructive || requested.credentials || requested.admin || requested.unknownRisk;
  const decision: SandboxDecision = policy.requireSandbox && !strong ? 'unavailable'
    : policy.mode === 'full-access' && !policy.requireSandbox ? 'native-allow'
    : !strong ? 'ask-unsandboxed'
    : risky || policy.mode === 'default' && (requested.network || requested.externalWrite) ? 'ask'
    : 'sandboxed-allow';
  return Object.freeze({ ...structuredClone(identity), policyRevision: policy.revision, mode: policy.mode, requested: Object.freeze({ ...requested }), decision });
}

/** This adapter explicitly advertises NO isolation. Approvals do not change that fact. */
export class NativeSandboxExecutor implements SandboxExecutor {
  readonly identity: SandboxExecutorIdentity;
  get naturalExitTreeProof(): 'unverified' | undefined { return process.platform === 'win32' ? 'unverified' : undefined; }
  constructor(hostId: string, readonly terminateTree: SandboxExecutor['terminate']) {
    this.identity = Object.freeze({ hostId, executorId: 'node-native', executorRevision: 'node-native.v1', boundaryRevision: `${process.platform}.native.v1`, capabilities: Object.freeze({ filesystem: false, network: false, processTree: false }) });
  }
  spawn(input: SandboxSpawnInput): ChildProcessWithoutNullStreams {
    if (input.signal.aborted) throw input.signal.reason ?? new Error('Process spawn cancelled.');
    if (input.boundary.decision !== 'native-allow' && input.boundary.decision !== 'ask-unsandboxed') throw new Error('Native executor cannot satisfy a sandboxed decision.');
    const options = { cwd: input.cwd, env: input.environment, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'] };
    return input.launch.kind === 'shell'
      ? spawn(input.launch.command, { ...options, shell: true })
      : spawn(input.launch.executable.executable.path, [...input.launch.executable.prefixArgv, ...input.launch.argv], { ...options, shell: false });
  }
  terminate(child: ChildProcessWithoutNullStreams, context: { signal: AbortSignal; deadline: string }): Promise<void> { return this.terminateTree(child, context); }
  confirmExit(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (child.pid === undefined) return Promise.resolve(); // Spawn failed: no OS child was created.
    if (process.platform === 'win32') return Promise.reject(new Error('Native Windows has no descendant containment proof.'));
    try { process.kill(-child.pid, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return Promise.resolve();
      return Promise.reject(error instanceof Error ? error : new Error('Native process-group confirmation failed.'));
    }
    return Promise.reject(new Error('Native process group still exists after root close.'));
  }
}

/** Preserve external CLI configuration. Only explicitly injected enterprise rules remove values. */
export function inheritedProcessEnvironment(environment: NodeJS.ProcessEnv, policy: ProcessGlobalPolicy): NodeJS.ProcessEnv {
  if ((policy.removeEnvironmentVariables?.length ?? 0) > 128 || policy.removeEnvironmentVariables?.some(key => !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key))) throw new TypeError('Global environment removal policy exceeds its bound.');
  const removed = new Set((policy.removeEnvironmentVariables ?? []).map(key => process.platform === 'win32' ? key.toUpperCase() : key));
  return Object.fromEntries(Object.entries(environment).filter(([key, value]) => value !== undefined && !removed.has(process.platform === 'win32' ? key.toUpperCase() : key)));
}
