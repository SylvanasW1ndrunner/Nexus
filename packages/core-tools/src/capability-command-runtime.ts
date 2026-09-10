import { createHash } from 'node:crypto';
import { PREPARED_TOOL_INTENT_REVISION, ToolExecutionError, expectedToolError, validatePreparedIntent, type AgentToolPermissionFacts, type InvocationLimits, type PreparedToolIntent, type ToolExecuteContext, type ToolPrepareContext } from '@dbagent/core-agent';
import type { PortableValue } from '@dbagent/shared';
import type { ExecutableLaunchDescriptor } from './executable-discovery.js';
import { ProcessRuntime, ProcessRuntimeError, type PreparedProcessExecution, type ProcessPathTarget } from './process-runtime.js';
import type { ProcessRequestedCapabilities } from './sandbox-executor.js';
import { assertAuthorizedProcessBoundary } from './process-tools.js';

export type CapabilityCommandInput = Readonly<{
  executable: ExecutableLaunchDescriptor;
  argv: readonly string[];
  cwd: string;
  pathTargets: readonly ProcessPathTarget[];
  hostTargets: readonly string[];
  requested: ProcessRequestedCapabilities;
  permission: Pick<AgentToolPermissionFacts, 'access' | 'recoveryClass' | 'dangerLevel' | 'actions'>;
  resourceKeys: readonly string[];
  timeoutMs?: number;
  limits?: InvocationLimits;
}>;

/** A restricted Host-owned port. It holds no configuration or process authority of its own. */
export class CapabilityCommandRuntime {
  constructor(private readonly runtime: ProcessRuntime) {}

  async prepare(input: CapabilityCommandInput, context: ToolPrepareContext): Promise<PreparedToolIntent> {
    if (!context.runPolicy) throw expectedToolError('precondition', 'A captured Run policy is required.');
    const plan = await invoke(() => this.runtime.prepareExecution({ hostId: context.hostId, runPolicy: context.runPolicy, launch: { kind: 'argv', executable: input.executable, argv: input.argv }, cwd: input.cwd, requested: input.requested, pathTargets: input.pathTargets, hostTargets: input.hostTargets }));
    const limits = { ...(input.limits ?? context.limits) };
    for (const key of Object.keys(limits) as Array<keyof InvocationLimits>) if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > context.limits[key]) throw expectedToolError('invalid_argument', 'Command limits exceed the registered Tool limits.');
    const timeoutMs = input.timeoutMs ?? Math.min(plan.runtimeLimits.defaultMs, plan.runtimeLimits.runMs, Math.max(1, limits.timeoutMs - 10_000));
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > plan.runtimeLimits.runMs || timeoutMs > limits.timeoutMs) throw expectedToolError('invalid_argument', 'Command timeout is invalid.');
    if (!Array.isArray(input.resourceKeys) || input.resourceKeys.length > 120 || input.resourceKeys.some(key => typeof key !== 'string' || !key || key.length > 4096 || /[\x00-\x1f]/u.test(key))) throw expectedToolError('invalid_argument', 'Command resource identities are invalid.');
    const readonly = input.permission.access === 'read';
    const facts: AgentToolPermissionFacts = {
      toolName: context.descriptor.flatName, ...input.permission, readonly, ...input.requested,
      unknownRisk: input.requested.unknownRisk || plan.boundary.decision === 'ask-unsandboxed',
      dangerLevel: input.requested.unknownRisk || plan.boundary.decision === 'ask-unsandboxed' ? 'high' : input.permission.dangerLevel,
      paths: [...new Set([plan.cwd, ...plan.pathTargets.map(target => target.canonicalPath)])], hosts: plan.hostTargets, resolvedAddresses: [],
      targets: [{ kind: 'process', boundary: plan.boundary as unknown as PortableValue, executableIdentity: createHash('sha256').update(JSON.stringify(plan.launch)).digest('hex') }],
    };
    const intent: PreparedToolIntent = {
      input: { plan: plan as unknown as PortableValue, timeoutMs }, targetIdentity: { kind: 'process-exec', plan } as unknown as PortableValue,
      runPolicy: context.runPolicy, generation: context.generation, toolRevision: context.toolRevision, handlerRevision: context.handlerRevision, intentRevision: PREPARED_TOOL_INTENT_REVISION,
      action: { summary: 'Run ' + context.descriptor.flatName }, permission: facts, access: facts.access, recoveryClass: facts.recoveryClass,
      concurrency: readonly ? 'read' : 'exclusive', resourceKeys: [...new Set(['process-run:' + context.runId, ...input.resourceKeys])], limits,
    };
    return validatePreparedIntent(intent);
  }

  async execute(input: Readonly<Record<string, PortableValue>>, context: ToolExecuteContext): Promise<unknown> {
    const plan = input.plan as unknown as PreparedProcessExecution;
    if (!plan || plan.launch?.kind !== 'argv') throw expectedToolError('precondition', 'Capability command requires an argv launch plan.');
    assertAuthorizedProcessBoundary(plan, context);
    if (plan.boundary.decision === 'unavailable') return { status: 'unavailable', summary: 'Required command sandbox enforcement is unavailable.', reason: 'required_sandbox_unavailable' };
    const owner = { hostId: context.hostId, sessionId: context.sessionId, runId: context.runId, signal: context.signal, deadline: context.deadline };
    const snapshot = await invoke(() => this.runtime.exec({ ...owner, prepared: plan, timeoutMs: input.timeoutMs as number }));
    if (snapshot.status === 'failed') throw expectedToolError('external', 'External command could not start.', { outcome: snapshot.pid === undefined ? 'not_applied' : 'unknown' });
    const spool = await invoke(() => this.runtime.readCompleteSpool({ ...owner, processId: snapshot.processId }));
    return {
      status: snapshot.status === 'exited' && snapshot.outputComplete && spool.outputComplete ? 'ok' : 'partial', summary: 'External command ' + snapshot.status + (snapshot.exitCode === null ? '.' : '; exit code ' + snapshot.exitCode + '.'),
      process: snapshot, spool,
      executionBoundary: { decision: plan.boundary.decision, enforcement: plan.boundary.capabilities.filesystem && plan.boundary.capabilities.network && plan.boundary.capabilities.processTree ? 'sandboxed' : 'native', treeStopProof: snapshot.treeStopProof, executorId: plan.boundary.executorId, executorRevision: plan.boundary.executorRevision, boundaryRevision: plan.boundary.boundaryRevision },
    };
  }
}

async function invoke<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (!(error instanceof ProcessRuntimeError)) throw expectedToolError('external', 'External command operation failed.', { outcome: 'unknown' });
    if (error.kind === 'target_changed') throw new ToolExecutionError({ code: 'target_changed', category: 'precondition', retryable: true, outcome: error.outcome }, 'Prepared command target changed; prepare again.');
    if (error.kind === 'timeout' || error.kind === 'cancelled') throw new ToolExecutionError({ code: error.kind === 'timeout' ? 'TOOL_TIMEOUT' : 'TOOL_CANCELLED', category: error.kind, retryable: false, outcome: error.outcome }, error.message);
    throw expectedToolError(error.kind === 'invalid_cursor' ? 'invalid_argument' : error.kind, error.message, { outcome: error.outcome });
  }
}
