import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';
import { PREPARED_TOOL_INTENT_REVISION, ToolExecutionError, expectedToolError, type AgentCapabilityLifecycleContext, type AgentCapabilityModule, type AgentCapabilityModuleRegistration, type AgentCapabilityModuleRuntime, type AgentCapabilityProbeChoice, type AgentCapabilityProbeResult, type AgentCapabilityStatus, type ToolExecuteContext, type ToolInvocationContribution, type ToolPrepareContext } from '@dbagent/core-agent';
import { prepareProcessPath, type ExecutableDiscoveryResult } from '@dbagent/core-tools';
import type { PortableValue } from '@dbagent/shared';
import type { CommandCapabilityOperation, CommandCapabilitySpec, FirstPartyCapabilityHost } from './types.js';
import { hasControlCodePoint } from './input-validation.js';

const LIMITS = Object.freeze({ timeoutMs: 45_000, maxInputBytes: 32_768, maxOutputBytes: 1_048_576, maxArtifactBytes: 1_048_576, maxDepth: 8, maxRecords: 512 });
const PROBE_TIMEOUT_MS = 2_000;
type AvailableExecutable = Readonly<{ name: string; launch: Extract<ExecutableDiscoveryResult, { status: 'available' }>['launch'] }>;

/** Shared module construction: probes only Host startup PATH and delegates execution to the Host command port. */
export function createCommandCapabilityRegistration(spec: CommandCapabilitySpec, host: FirstPartyCapabilityHost): AgentCapabilityModuleRegistration {
  let generation = 0;
  return Object.freeze({
    manifest: Object.freeze({ id: spec.moduleId, version: spec.version, description: spec.description, capabilities: Object.freeze([{ id: spec.capabilityId, description: spec.description }]) }),
    instanceId: spec.instanceId,
    load: () => Promise.resolve(createModule(spec, host, () => ++generation)),
  });
}
function createModule(spec: CommandCapabilitySpec, host: FirstPartyCapabilityHost, nextGeneration: () => number): AgentCapabilityModule {
  const providers = new WeakMap<AgentCapabilityModuleRuntime, string>();
  const discover = async (context?: AgentCapabilityLifecycleContext): Promise<readonly AvailableExecutable[]> => {
    const all = await Promise.all(spec.executables.map(async name => ({ name, result: await boundedProbe(() => host.executables.discover(name), context) })));
    return all.filter((entry): entry is { name: string; result: Extract<ExecutableDiscoveryResult, { status: 'available' }> } => entry.result.status === 'available').map(entry => Object.freeze({ name: entry.name, launch: entry.result.launch }));
  };
  const runtime = async (selected?: string, context?: AgentCapabilityLifecycleContext): Promise<AgentCapabilityModuleRuntime> => {
    const candidates = await discover(context);
    if (!candidates.length) throw expectedToolError('precondition', `${spec.capabilityId} is unavailable because its external CLI was not found.`);
    const executable = selected ? candidates.find(candidate => candidate.name === selected) : candidates.length === 1 ? candidates[0] : undefined;
    if (!executable) throw expectedToolError('precondition', `${spec.capabilityId} requires selection of an externally available CLI.`);
    const generation = `${spec.moduleId}:${nextGeneration()}:${fingerprint(executable)}`;
    const built = Object.freeze({ contributions: Object.freeze({ tools: Object.freeze(spec.operations.filter(operation => operation.providers === undefined || operation.providers.includes(executable.name)).map(operation => createContribution(operation, executable, host, generation))) }), close: () => Promise.resolve(undefined) });
    providers.set(built, executable.name);
    return built;
  };
  return Object.freeze({ probe: async (context?: AgentCapabilityLifecycleContext) => probeResult(spec, await discover(context)), activate: async (context?: AgentCapabilityLifecycleContext) => runtime(undefined, context), resolve: async (candidateId: string, context?: AgentCapabilityLifecycleContext) => runtime(candidateId, context), refresh: async (current: AgentCapabilityModuleRuntime, context?: AgentCapabilityLifecycleContext) => {
    const provider = providers.get(current);
    if (!provider) throw expectedToolError('precondition', 'Capability generation has no captured external provider.');
    return runtime(provider, context);
  }, dispose: () => Promise.resolve(undefined) });
}
function probeResult(spec: CommandCapabilitySpec, available: readonly AvailableExecutable[]): AgentCapabilityProbeResult {
  const partial = spec.degradeWhenPartialAvailability === true && available.length > 0 && available.length < spec.executables.length;
  const status: AgentCapabilityStatus = available.length ? partial ? 'degraded' : 'available' : 'unavailable';
  const reason = !available.length ? `Install ${spec.executables.join(' or ')} externally and restart the Host after changing PATH.` : partial ? `Only ${available.map(candidate => candidate.name).join(', ')} is available; install the remaining external CLI choices and restart the Host after changing PATH.` : undefined;
  const choices = available.map(choice);
  const capability = reason === undefined ? Object.freeze({ status }) : Object.freeze({ status, reason });
  const base = reason === undefined ? { status, capabilities: Object.freeze({ [spec.capabilityId]: capability }) } : { status, reason, capabilities: Object.freeze({ [spec.capabilityId]: capability }) };
  return Object.freeze({ ...base, ...(available.length > 1 && (spec.selection ?? 'automatic') === 'choice_required' ? { activation: Object.freeze({ kind: 'external_context' as const, selection: 'choice_required' as const, providerId: spec.moduleId, probeRevision: 'first-party-command-probe.v1', candidates: Object.freeze(choices) }) } : {}) });
}
function choice(candidate: AvailableExecutable): AgentCapabilityProbeChoice { return Object.freeze({ candidateId: candidate.name, label: candidate.name, description: `${candidate.name} discovered from the Host startup PATH.`, metadata: Object.freeze({ kind: candidate.launch.kind }), fingerprint: fingerprint(candidate) }); }
function fingerprint(candidate: AvailableExecutable): string { return createHash('sha256').update(JSON.stringify(candidate.launch)).digest('hex'); }
function createContribution(operation: CommandCapabilityOperation, executable: AvailableExecutable, host: FirstPartyCapabilityHost, generation: string): ToolInvocationContribution {
  const permission = operation.permission;
  const readonly = permission.recoveryClass === 'read' && permission.externalWrite !== true && permission.destructive !== true;
  return Object.freeze({
    definition: Object.freeze({ name: operation.name, description: operation.description, inputSchema: operation.inputSchema, outputSchema: { type: 'object' as const }, dangerLevel: permission.dangerLevel, readonly, source: 'first_party', exposure: 'direct', access: permission.access, recoveryClass: permission.recoveryClass, toolRevision: `${operation.name}@1`, handlerRevision: 'first-party-command-handler@1', intentRevision: PREPARED_TOOL_INTENT_REVISION, limits: LIMITS, execution: { concurrency: permission.access === 'read' ? 'read' as const : 'exclusive' as const, timeoutMs: LIMITS.timeoutMs }, failurePolicy: { onUnknown: { failureKind: 'unknown' as const, retryable: false } } }),
    runtime: Object.freeze({
      revision: Object.freeze({ toolName: operation.name, toolRevision: `${operation.name}@1`, handlerRevision: 'first-party-command-handler@1', intentRevision: PREPARED_TOOL_INTENT_REVISION }),
      prepare: async (input: Readonly<Record<string, PortableValue>>, context: ToolPrepareContext) => {
        const raw = asRecord(input); const argv = boundedArgv(operation.argv(raw, executable.name)); const paths = await preparePaths(operation.pathInputs?.(raw) ?? [], host.workspaceRoot);
        const hostTargets = operation.hostTargets ?? [];
        if (hostTargets.length && !permission.network) throw expectedToolError('precondition', 'External host targets require a network permission declaration.');
        return host.command.prepare({ executable: executable.launch, argv, cwd: host.workspaceRoot, pathTargets: paths, hostTargets, requested: { network: permission.network, externalWrite: permission.externalWrite, destructive: permission.destructive, credentials: false, admin: permission.admin, unknownRisk: permission.unknownRisk }, permission: { access: permission.access, recoveryClass: permission.recoveryClass, dangerLevel: permission.dangerLevel, actions: permission.actions }, resourceKeys: [`first-party:${operation.name}`, `generation:${generation}`, ...paths.map(path => `path:${path.canonicalPath}`), ...hostTargets.map(target => `host:${target}`)], limits: LIMITS }, context);
      },
      execute: async (input: Readonly<Record<string, PortableValue>>, context: ToolExecuteContext) => {
        const result = await host.command.execute(input, context) as Record<string, unknown>;
        const exitCode = ((result.process as Record<string, unknown> | undefined)?.exitCode);
        if (result.status === 'partial' || ((typeof exitCode === 'number' && exitCode !== 0) && !(operation.output === 'json' && operation.allowNonZeroJson === true))) {
          throw expectedToolError('external', `External CLI did not complete successfully.${commandDiagnostics(result)}`, { outcome: 'unknown' });
        }
        if (operation.output === 'json' && result.status !== 'unavailable') {
          const text = (((result.spool as Record<string, unknown> | undefined)?.stdout as Record<string, unknown> | undefined)?.text);
          if (typeof text !== 'string' || text.length > LIMITS.maxOutputBytes) throw expectedToolError('external', 'External CLI returned unreadable or oversized structured output.', { outcome: 'unknown' });
          try { return Object.freeze({ ...result, structured: JSON.parse(text) as PortableValue }); }
          catch { throw expectedToolError('external', 'External CLI returned invalid structured output.', { outcome: 'unknown' }); }
        }
        return result;
      },
    }),
  });
}
function asRecord(input: PortableValue): Readonly<Record<string, unknown>> { if (!input || typeof input !== 'object' || Array.isArray(input)) throw expectedToolError('invalid_argument', 'Tool input must be an object.'); return input; }
function boundedArgv(argv: readonly string[]): readonly string[] { if (argv.length > 64) throw expectedToolError('invalid_argument', 'Command arguments are invalid.'); for (const value of argv) { if (!value || value.length > 16_384 || hasControlCodePoint(value)) throw expectedToolError('invalid_argument', 'Command arguments are invalid.'); } return Object.freeze([...argv]); }
async function preparePaths(inputs: readonly string[], root: string) { if (inputs.length > 64) throw expectedToolError('invalid_argument', 'Too many path arguments.'); const workspace = await prepareProcessPath('.', root); return Promise.all(inputs.map(async input => { if (!input || input.length > 8_192 || hasControlCodePoint(input)) throw expectedToolError('invalid_argument', 'Path argument is invalid.'); const candidate = resolve(root, input); assertWorkspacePath(root, candidate); const prepared = await prepareProcessPath(candidate, root); assertWorkspacePath(workspace.canonicalPath, prepared.canonicalPath); return prepared; })); }
function assertWorkspacePath(root: string, candidate: string): void { const outside = relative(resolve(root), resolve(candidate)); if (isAbsolute(outside) || outside === '..' || /^\.\.[\\/]/u.test(outside)) throw expectedToolError('invalid_argument', 'Path argument must stay inside the workspace.'); }
async function boundedProbe<T>(operation: () => Promise<T>, context?: AgentCapabilityLifecycleContext): Promise<T> {
  if (context?.signal.aborted) throw cancelledProbeError();
  const suppliedDeadline = context?.deadline === undefined ? Number.POSITIVE_INFINITY : Date.parse(context.deadline);
  const deadline = Math.min(Date.now() + PROBE_TIMEOUT_MS, Number.isFinite(suppliedDeadline) ? suppliedDeadline : Date.now() + PROBE_TIMEOUT_MS);
  if (Date.now() >= deadline) throw timedOutProbeError();
  return new Promise<T>((resolveResult, rejectResult) => {
    const timeout = setTimeout(() => finish(() => rejectResult(timedOutProbeError())), Math.max(1, deadline - Date.now()));
    const abort = () => finish(() => rejectResult(cancelledProbeError()));
    const finish = (settle: () => void) => { clearTimeout(timeout); context?.signal.removeEventListener('abort', abort); settle(); };
    context?.signal.addEventListener('abort', abort, { once: true });
    operation().then(value => finish(() => resolveResult(value)), error => finish(() => rejectResult(error instanceof Error ? error : new Error('Capability probe failed.'))));
  });
}
function cancelledProbeError(): ToolExecutionError { return new ToolExecutionError({ code: 'TOOL_CANCELLED', category: 'cancelled', retryable: false, outcome: 'not_applied' }, 'Capability probe was cancelled.'); }
function timedOutProbeError(): ToolExecutionError { return new ToolExecutionError({ code: 'TOOL_TIMEOUT', category: 'timeout', retryable: false, outcome: 'not_applied' }, 'Capability probe timed out.'); }
function commandDiagnostics(result: Readonly<Record<string, unknown>>): string {
  const spool = result.spool as Readonly<Record<string, unknown>> | undefined;
  const stdout = (spool?.stdout as Readonly<Record<string, unknown>> | undefined)?.text;
  const stderr = (spool?.stderr as Readonly<Record<string, unknown>> | undefined)?.text;
  const details = [typeof stdout === 'string' ? `stdout: ${stdout.slice(0, 1_800)}` : undefined, typeof stderr === 'string' ? `stderr: ${stderr.slice(0, 1_800)}` : undefined].filter((value): value is string => value !== undefined);
  return details.length ? ` ${details.join(' | ')}` : '';
}
