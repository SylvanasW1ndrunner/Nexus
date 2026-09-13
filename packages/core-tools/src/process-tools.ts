import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { PREPARED_TOOL_INTENT_REVISION, ToolExecutionError, expectedToolError, type AgentToolPermissionFacts, type ToolInvocationContribution, type ToolTargetRevalidator, type ToolPrepareContext, type PreparedToolIntent, type ToolExecuteContext } from '@dbagent/core-agent';
import type { PortableValue } from '@dbagent/shared';
import { prepareProcessPath, ProcessRuntimeError, type ProcessPathTarget, type ProcessRuntime, type ProcessRuntimeSnapshot, type PreparedProcessExecution, type PreparedProcessTarget, type ProcessOutputCursor, type ProcessOwner } from './process-runtime.js';
import type { ProcessRequestedCapabilities } from './sandbox-executor.js';

export type ProcessToolOptions = { rootPath: string; runtime?: ProcessRuntime; handlerRevision?: string; defaultTimeoutMs?: number; maxTimeoutMs?: number; maxPollWaitMs?: number };
const MAX_COMMAND = 16_384;
const MAX_STDIN = 65_536;
const MAX_RUNTIME_MS = 1_800_000;
const limits = { timeoutMs: MAX_RUNTIME_MS + 15_000, maxInputBytes: 262_144, maxOutputBytes: 65_536, maxArtifactBytes: 128 * 1024 * 1024, maxDepth: 20, maxRecords: 2000 } as const;
const outputSchema = { type: 'object', additionalProperties: false, required: ['status', 'summary'], properties: {
  status: { type: 'string', enum: ['ok', 'partial', 'unavailable'] }, summary: { type: 'string' }, reason: { type: 'string' },
  process: { type: 'object' }, retainedOutput: { type: 'boolean' }, executionBoundary: { type: 'object' },
} };
const cursorSchema = { type: 'object', additionalProperties: false, required: ['processId', 'stdoutBytes', 'stderrBytes'], properties: { processId: { type: 'string', minLength: 1, maxLength: 128 }, stdoutBytes: { type: 'integer', minimum: 0 }, stderrBytes: { type: 'integer', minimum: 0 } } };
const boolCapabilities = { type: 'object', additionalProperties: false, properties: Object.fromEntries(['network', 'externalWrite', 'destructive', 'credentials', 'admin'].map(key => [key, { type: 'boolean' }])) };

export function createProcessToolContributions(options: ProcessToolOptions): readonly ToolInvocationContribution[] {
  return [createProcessExecToolContribution(options), createProcessControlToolContribution(options)];
}

export function createProcessExecToolContribution(options: ProcessToolOptions): ToolInvocationContribution {
  const handlerRevision = options.handlerRevision ?? 'process_exec.handler.v1';
  return {
    definition: {
      ...definition('process_exec', handlerRevision),
      description: 'Execute a bounded foreground or background command using the captured Host sandbox boundary. Continue with process_control.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['command'], properties: {
        command: { type: 'string', minLength: 1, maxLength: MAX_COMMAND }, cwd: { type: 'string', maxLength: 8192 },
        background: { type: 'boolean' }, timeoutMs: { type: 'integer', minimum: 1, maximum: MAX_RUNTIME_MS }, capabilities: boolCapabilities,
      } },
    },
    runtime: {
      revision: revision('process_exec', handlerRevision),
      async prepare(input, context) {
        if (options.runtime === undefined) return availabilityIntent(context, 'process_backend_unavailable');
        const command = requiredString(input.command, 'command', MAX_COMMAND);
        const root = await invoke(() => realpath(options.rootPath));
        const cwd = await invoke(() => realpath(resolve(root, typeof input.cwd === 'string' ? input.cwd : '.')));
        const outside = relative(root, cwd);
        const externalWrite = outside === '..' || outside.startsWith('..' + sep) || isAbsolute(outside);
        const classified = await classifyCommand(command, externalWrite, input.capabilities, root, cwd);
        const plan = await invoke(() => options.runtime!.prepareExecution({ hostId: context.hostId, runPolicy: context.runPolicy, command, cwd, requested: classified.requested, pathTargets: classified.pathTargets, hostTargets: classified.hosts }));
        if (plan.boundary.decision === 'unavailable') return availabilityIntent(context, 'required_sandbox_unavailable', { kind: 'process-exec', plan } as unknown as PortableValue);
        const max = Math.min(integer(options.maxTimeoutMs, MAX_RUNTIME_MS, 1, MAX_RUNTIME_MS), plan.runtimeLimits.runMs);
        const timeoutMs = integer(input.timeoutMs, Math.min(options.defaultTimeoutMs ?? plan.runtimeLimits.defaultMs, max), 1, max);
        const preparedInput: Record<string, PortableValue> = {
          command, cwd, background: input.background === true, timeoutMs,
          ...(plan === undefined ? { unavailable: true } : { plan: plan as unknown as PortableValue }),
        };
        const request = classified.requested;
        const facts = permission(context, 'external', 'non_idempotent', ['execute', ...(request.network ? ['network'] : []), ...(request.destructive ? ['delete'] : []), ...(request.credentials ? ['credential'] : []), ...(request.admin ? ['admin'] : [])] as AgentToolPermissionFacts['actions']);
        facts.paths = [...new Set([cwd, ...plan.pathTargets.map(target => target.canonicalPath)])]; facts.hosts = classified.hosts;
        Object.assign(facts, request, { unknownRisk: request.unknownRisk || plan?.boundary.decision === 'ask-unsandboxed' });
        facts.dangerLevel = request.destructive || request.credentials || request.admin || facts.unknownRisk ? 'high' : 'safe';
        facts.targets = [{ kind: 'process', commandSummary: command.slice(0, 2048), paths: plan.pathTargets as unknown as PortableValue, boundary: plan.boundary as unknown as PortableValue }];
        return intent(context, preparedInput, plan === undefined ? null : { kind: 'process-exec', plan } as unknown as PortableValue, facts, 'exclusive', ['process-run:' + context.runId], 'Execute ' + command.slice(0, 2048), timeoutMs + 10_000);
      },
      async execute(input, context) {
        if (input.unavailable === true) return unavailable(input.reason as string);
        if (options.runtime === undefined) return unavailable('process_backend_unavailable');
        const plan = input.plan as unknown as PreparedProcessExecution;
        if (plan.boundary.decision === 'unavailable') return unavailable('required_sandbox_unavailable');
        assertAuthorizedProcessBoundary(plan, context);
        await invoke(() => options.runtime!.revalidate({ kind: 'process-exec', plan }, context.signal));
        const owner = ownerFor(context);
        const snapshot = await invoke(() => options.runtime!.exec({ ...owner, prepared: plan, background: input.background === true, timeoutMs: input.timeoutMs as number, deadline: context.deadline, signal: input.background === true ? context.runSignal ?? context.signal : context.signal }));
        const result = payload(snapshot);
        return { ...result, ...(input.background !== true && hasTruncatedOutput(snapshot) ? { retainedOutput: true } : {}), executionBoundary: { decision: plan.boundary.decision, enforcement: plan.boundary.decision === 'native-allow' || plan.boundary.decision === 'ask-unsandboxed' ? 'native' : 'sandboxed', executorId: plan.boundary.executorId, executorRevision: plan.boundary.executorRevision, boundaryRevision: plan.boundary.boundaryRevision } };
      },
      retainResult: processResultRetention(options),
    },
  };
}

export function createProcessControlToolContribution(options: ProcessToolOptions): ToolInvocationContribution {
  const handlerRevision = options.handlerRevision ?? 'process_control.handler.v1';
  const common = { processId: { type: 'string', minLength: 1, maxLength: 128 } };
  return {
    definition: {
      ...definition('process_control', handlerRevision),
      description: 'Poll bounded process output, write bounded stdin, or terminate a captured process tree. A cursor is bound to exactly one handle.',
      inputSchema: { oneOf: [
        { type: 'object', additionalProperties: false, required: ['action', 'processId'], properties: { ...common, action: { const: 'poll' }, cursor: cursorSchema, waitMs: { type: 'integer', minimum: 0, maximum: 30_000 }, maxProjectionBytes: { type: 'integer', minimum: 32, maximum: 262_144 }, includeSpool: { type: 'boolean' } } },
        { type: 'object', additionalProperties: false, required: ['action', 'processId', 'input'], properties: { ...common, action: { const: 'write' }, input: { type: 'string', maxLength: MAX_STDIN }, end: { type: 'boolean' }, timeoutMs: { type: 'integer', minimum: 1, maximum: 5000 } } },
        { type: 'object', additionalProperties: false, required: ['action', 'processId'], properties: { ...common, action: { const: 'terminate' } } },
      ] },
    },
    runtime: {
      revision: revision('process_control', handlerRevision),
      async prepare(input, context) {
        if (options.runtime === undefined) return availabilityIntent(context, 'process_backend_unavailable');
        const action = controlAction(input.action);
        const processId = requiredString(input.processId, 'processId', 128);
        const owner = ownerFor(context);
        const target = options.runtime === undefined ? undefined : await invoke(() => options.runtime!.prepareControl(owner, processId, action));
        const runtimeLimits = options.runtime.preparationLimits();
        const prepared: Record<string, PortableValue> = { action, processId, ...(target === undefined ? { unavailable: true } : { target: target as unknown as PortableValue }) };
        if (action === 'poll') {
          prepared.waitMs = integer(input.waitMs, 0, 0, options.maxPollWaitMs ?? 30_000);
          prepared.maxProjectionBytes = integer(input.maxProjectionBytes, runtimeLimits.projectionBytes, 1, runtimeLimits.projectionBytes);
          prepared.includeSpool = input.includeSpool === true;
          if (input.cursor !== undefined) prepared.cursor = input.cursor;
        } else if (action === 'write') {
          if (typeof input.input !== 'string' || Buffer.byteLength(input.input, 'utf8') > Math.min(MAX_STDIN, runtimeLimits.stdinBytes)) throw expectedToolError('limit', 'stdin exceeds its UTF-8 byte quota.');
          prepared.input = input.input; prepared.end = input.end === true; prepared.timeoutMs = integer(input.timeoutMs, Math.min(5000, runtimeLimits.stdinMs), 1, Math.min(5000, runtimeLimits.stdinMs));
        }
        const facts = permission(context, action === 'poll' ? 'read' : action === 'terminate' ? 'destructive' : 'write', action === 'poll' ? 'read' : 'non_idempotent', action === 'poll' ? ['read'] : action === 'terminate' ? ['execute', 'delete'] : ['execute', 'write']);
        facts.destructive = action === 'terminate'; facts.dangerLevel = action === 'poll' ? 'safe' : 'high';
        facts.targets = [{ kind: 'process', processId, action }];
        return intent(context, prepared, target === undefined ? null : target as unknown as PortableValue, facts, action === 'poll' ? 'read' : 'exclusive', ['process:' + processId], action + ' process ' + processId, action === 'poll' ? (prepared.waitMs as number) + 10_000 : 15_000);
      },
      async execute(input, context) {
        if (input.unavailable === true) return unavailable(input.reason as string);
        if (options.runtime === undefined) return unavailable('process_backend_unavailable');
        const action = controlAction(input.action);
        const target = input.target as unknown as PreparedProcessTarget;
        await invoke(() => options.runtime!.revalidate(target, context.signal));
        const base = { ...ownerFor(context), processId: input.processId as string, signal: context.signal, deadline: context.deadline };
        const snapshot = await invoke(() => action === 'poll'
          ? options.runtime!.poll({ ...base, ...(input.cursor === undefined ? {} : { cursor: input.cursor as unknown as ProcessOutputCursor }), waitMs: input.waitMs as number, maxProjectionBytes: input.maxProjectionBytes as number })
          : action === 'write' ? options.runtime!.write({ ...base, input: input.input as string, end: input.end === true, timeoutMs: input.timeoutMs as number })
          : options.runtime!.terminate(base));
        const result = payload(snapshot);
        return { ...result, ...(action === 'poll' && input.includeSpool === true ? { retainedOutput: true } : {}) };
      },
      retainResult: processResultRetention(options),
    },
  };
}

/** Compose this Host revalidator for process targets; execute repeats the same validation before I/O. */
export function createProcessTargetRevalidator(runtime: ProcessRuntime): ToolTargetRevalidator {
  return async (prepared, context) => {
    const target = prepared.targetIdentity as unknown as PreparedProcessTarget;
    if (!target || target.kind !== 'process-exec' && target.kind !== 'process-control') return;
    await invoke(() => runtime.revalidate(target, context.signal));
  };
}

function definition(name: 'process_exec' | 'process_control', handlerRevision: string) {
  return { name, aliases: [], tags: ['process'], outputSchema, dangerLevel: 'high' as const, readonly: false, source: 'runtime' as const, exposure: 'direct' as const, permission: { actions: ['execute'] as const }, access: 'external' as const, recoveryClass: 'non_idempotent' as const, limits, toolRevision: name + '.v1', handlerRevision, intentRevision: PREPARED_TOOL_INTENT_REVISION, execution: { concurrency: 'exclusive' as const, timeoutMs: limits.timeoutMs }, failurePolicy: { onUnknown: { failureKind: 'unknown' as const, retryable: false } }, presentation: { category: 'command', preparingMessage: '正在准备有界进程操作。' } };
}
function revision(name: string, handlerRevision: string) { return { toolName: name, toolRevision: name + '.v1', handlerRevision, intentRevision: PREPARED_TOOL_INTENT_REVISION }; }
function permission(context: ToolPrepareContext, access: AgentToolPermissionFacts['access'], recoveryClass: AgentToolPermissionFacts['recoveryClass'], actions: AgentToolPermissionFacts['actions']): { -readonly [K in keyof AgentToolPermissionFacts]: AgentToolPermissionFacts[K] } {
  return { toolName: context.descriptor.flatName, dangerLevel: 'safe', readonly: access === 'read', access, recoveryClass, actions, paths: [], hosts: [], network: false, externalWrite: false, destructive: false, credentials: false, admin: false, unknownRisk: false, resolvedAddresses: [], targets: [] };
}
function intent(context: ToolPrepareContext, input: Record<string, PortableValue>, targetIdentity: PortableValue, facts: AgentToolPermissionFacts, concurrency: 'read' | 'exclusive', resourceKeys: string[], summary: string, timeoutMs: number): PreparedToolIntent {
  return { input, toolRevision: context.toolRevision, handlerRevision: context.handlerRevision, intentRevision: context.intentRevision, generation: context.generation, targetIdentity, action: { summary }, permission: facts, access: facts.access, recoveryClass: facts.recoveryClass, concurrency, resourceKeys, limits: { ...context.limits, timeoutMs: Math.min(context.limits.timeoutMs, timeoutMs) } };
}
function ownerFor(context: Pick<ToolExecuteContext, 'hostId' | 'sessionId' | 'runId'>): ProcessOwner { return { hostId: context.hostId, sessionId: context.sessionId, runId: context.runId }; }
function controlAction(value: unknown): 'poll' | 'write' | 'terminate' { if (value !== 'poll' && value !== 'write' && value !== 'terminate') throw expectedToolError('invalid_argument', 'Invalid process control action.'); return value; }
function requiredString(value: unknown, name: string, max: number): string { if (typeof value !== 'string' || !value.trim() || value.length > max) throw expectedToolError('invalid_argument', name + ' is invalid.'); return value; }
function integer(value: unknown, fallback: number, min: number, max: number): number { const result = value === undefined ? fallback : value; if (typeof result !== 'number' || !Number.isSafeInteger(result) || result < min || result > max) throw expectedToolError('invalid_argument', 'Process numeric input is out of bounds.'); return result; }
function unavailable(reason: string) { return { status: 'unavailable', summary: 'The requested process backend or sandbox enforcement is unavailable.', reason }; }
function availabilityIntent(context: ToolPrepareContext, reason: string, target: PortableValue = null): PreparedToolIntent {
  return intent(context, { unavailable: true, reason }, target, permission(context, 'read', 'read', ['read']), 'read', [], 'Process backend availability: ' + reason, 5000);
}
function payload(snapshot: ProcessRuntimeSnapshot) {
  if (snapshot.status === 'unknown') throw expectedToolError('external', 'Process execution or tree cleanup is unconfirmed.', { outcome: 'unknown' });
  if (snapshot.status === 'failed') throw expectedToolError('external', 'Process execution failed.', { outcome: snapshot.pid === undefined ? 'not_applied' : 'unknown' });
  if (!snapshot.outputComplete && snapshot.status !== 'orphaned' && snapshot.exitCode === null) throw expectedToolError('external', 'Process result and output integrity cannot be confirmed.', { outcome: 'unknown' });
  return { status: !snapshot.outputComplete || snapshot.status === 'orphaned' || snapshot.status === 'timed_out' || snapshot.status === 'terminated' ? 'partial' : 'ok', summary: 'Process ' + snapshot.processId + ': ' + snapshot.status + (snapshot.exitCode === null ? '' : ', exit code ' + snapshot.exitCode) + (!snapshot.outputComplete ? '; output is incomplete.' : '.'), process: snapshot };
}
function hasTruncatedOutput(snapshot: ProcessRuntimeSnapshot): boolean {
  return snapshot.output.stdout.truncated || snapshot.output.stderr.truncated;
}
function processResultRetention(options: ProcessToolOptions) {
  return async (result: PortableValue, context: ToolExecuteContext) => {
    if (options.runtime === undefined || result === null || typeof result !== 'object' || Array.isArray(result)) return undefined;
    const record = result as Record<string, PortableValue>;
    if (record.retainedOutput !== true || record.process === null || typeof record.process !== 'object' || Array.isArray(record.process)) return undefined;
    const processId = (record.process as Record<string, PortableValue>).processId;
    if (typeof processId !== 'string' || processId.trim() === '') return undefined;
    const spool = await invoke(() => options.runtime!.readCompleteSpool({ ...ownerFor(context), processId, signal: context.signal, deadline: context.deadline }));
    const bytes = new TextEncoder().encode(JSON.stringify(spool));
    return { mediaType: 'application/json', source: oneChunk(bytes), expectedByteSize: bytes.byteLength, identity: processId };
  };
}
// eslint-disable-next-line @typescript-eslint/require-await -- AsyncIterable must retain the synchronous single-chunk behavior.
async function* oneChunk(bytes: Uint8Array): AsyncIterable<Uint8Array> { yield bytes; }
export function assertAuthorizedProcessBoundary(plan: PreparedProcessExecution, context: ToolExecuteContext): void {
  if (context.hostId !== plan.boundary.hostId || context.authorization.policyMode !== plan.boundary.mode || context.authorization.policyRevision !== plan.boundary.policyRevision) throw new ToolExecutionError({ code: 'target_changed', category: 'precondition', retryable: true, outcome: 'not_applied' }, 'Process Host or effective global policy changed; prepare again.');
  if ((plan.boundary.decision === 'ask' || plan.boundary.decision === 'ask-unsandboxed') && context.authorization.approvalId === undefined) throw expectedToolError('precondition', 'This process boundary requires explicit approval.');
}
async function classifyCommand(command: string, externalWrite: boolean, raw: PortableValue | undefined, root: string, cwd: string): Promise<{ requested: ProcessRequestedCapabilities; hosts: string[]; pathTargets: ProcessPathTarget[] }> {
  const declared = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, PortableValue> : {};
  const hosts = [...new Set([...command.matchAll(/https?:\/\/[^\s"'<>]+/giu)].map(match => { try { return new URL(match[0]).hostname; } catch { return ''; } }).filter(Boolean))];
  const tokens = [...command.matchAll(/"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s"']+)/gu)].map(match => match[1] ?? match[2] ?? match[3]!);
  const paths = [...new Set(tokens.filter(token => !/^https?:\/\//iu.test(token) && !token.startsWith('-') && !/[|;&<>$\x60*?~]/u.test(token) && (token.includes('/') || token.includes('\\'))))];
  if (hosts.length > 64 || paths.length > 64) throw expectedToolError('limit', 'Command contains too many permission targets.');
  const executable = command.trim().split(/\s+/u)[0]!.toLowerCase();
  const known = /^(?:git|node|npm|pnpm|yarn|python3?|pip3?|go|cargo|rustc|dotnet|java|javac|ls|dir|pwd|echo|cat|head|tail|rg|find|grep|curl|wget|psql|mysql|docker|kubectl|az|aws|gcloud|mkdir|cp|mv|copy)$/u.test(executable);
  const pathTargets = await Promise.all(paths.map(path => prepareProcessPath(path, cwd)));
  const outside = pathTargets.some(target => { const child = relative(root, target.canonicalPath); return child === '..' || child.startsWith('..' + sep) || isAbsolute(child); });
  return { hosts, pathTargets, requested: {
    network: declared.network === true || hosts.length > 0 || /(?:curl|wget|ssh|git\s+(?:clone|fetch|pull|push)|npm\s+(?:install|publish)|pnpm\s+(?:install|add)|pip\s+install|aws|gcloud|kubectl)\b/iu.test(command),
    externalWrite: declared.externalWrite === true || externalWrite || outside,
    destructive: declared.destructive === true || /\b(?:rm|rmdir|del|erase|format|drop|truncate|remove-item)\b/iu.test(command),
    credentials: declared.credentials === true,
    admin: declared.admin === true || /\b(?:sudo|su|runas|administrator|elevated)\b/iu.test(command),
    // Unparsed arguments may be paths, config indirection or shell expansion.
    // Recognized canonical targets never claim to exhaust command semantics.
    unknownRisk: !known || /[|;&<>$\x60*?~]/u.test(command) || tokens.slice(1).some(token => !paths.includes(token) && !/^https?:\/\//iu.test(token)),
  } };
}
async function invoke<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch (error) {
    if (!(error instanceof ProcessRuntimeError)) { if (error instanceof ToolExecutionError) throw error; throw expectedToolError('external', 'Process backend operation failed safely.', { outcome: 'unknown' }); }
    if (error.kind === 'target_changed') throw new ToolExecutionError({ code: 'target_changed', category: 'precondition', retryable: true, outcome: error.outcome }, error.message);
    if (error.kind === 'timeout' || error.kind === 'cancelled') throw new ToolExecutionError({ code: error.kind === 'timeout' ? 'TOOL_TIMEOUT' : 'TOOL_CANCELLED', category: error.kind, retryable: false, outcome: error.outcome }, error.message);
    if (error.kind === 'invalid_cursor') throw expectedToolError('invalid_cursor', error.message);
    throw expectedToolError(error.kind, error.message, { outcome: error.outcome });
  }
}
