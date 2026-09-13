import { readFile, lstat, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { PREPARED_TOOL_INTENT_REVISION, ToolExecutionError, expectedToolError, validatePreparedIntent, type AgentCapabilityModule, type AgentCapabilityModuleRegistration, type AgentCapabilityModuleRuntime, type AgentToolPermissionFacts, type PreparedToolIntent, type ToolExecuteContext, type ToolInvocationContribution, type ToolPrepareContext } from '@dbagent/core-agent';
import { prepareProcessPath } from '@dbagent/core-tools';
import type { PortableValue } from '@dbagent/shared';
import { createCommandCapabilityRegistration } from './command-module.js';
import type { CommandCapabilityOperation, FirstPartyCapabilityHost } from './types.js';
import { hasControlCodePoint } from './input-validation.js';

const LIMITS = Object.freeze({ timeoutMs: 45_000, maxInputBytes: 1_048_576, maxOutputBytes: 1_048_576, maxArtifactBytes: 1_048_576, maxDepth: 8, maxRecords: 2_000 });
const read = Object.freeze({ access: 'read' as const, recoveryClass: 'read' as const, dangerLevel: 'safe' as const, actions: Object.freeze(['read'] as const), network: false, externalWrite: false, destructive: false, admin: false, unknownRisk: false });
const execute = Object.freeze({ access: 'write' as const, recoveryClass: 'non_idempotent' as const, dangerLevel: 'high' as const, actions: Object.freeze(['write', 'execute'] as const), network: false, externalWrite: false, destructive: false, admin: false, unknownRisk: true });
const source = { type: 'object', additionalProperties: false, required: ['input'], properties: { input: { type: 'string', minLength: 1, maxLength: 8192 } } } as const;
const run = { type: 'object', additionalProperties: false, required: ['input', 'output'], properties: { input: { type: 'string', minLength: 1, maxLength: 8192 }, output: { type: 'string', minLength: 1, maxLength: 8192 } } } as const;

/** Bounded local data inspection plus an externally installed Jupyter execution tool. */
export function createDataNotebookCapability(host: FirstPartyCapabilityHost): AgentCapabilityModuleRegistration {
  return Object.freeze({
    manifest: Object.freeze({ id: 'schemanaut.data-notebook', version: '1.0.0', description: 'Bounded local data/notebook inspection and optional external Jupyter execution.', capabilities: Object.freeze([{ id: 'schemanaut.data-notebook', description: 'Data and notebook operations.' }]) }),
    instanceId: 'first-party-data-notebook', load: () => Promise.resolve(module(host)),
  });
}

function module(host: FirstPartyCapabilityHost): AgentCapabilityModule {
  const probe = async () => {
    const jupyter = await host.executables.discover('jupyter');
    if (jupyter.status === 'available') return { status: 'available' as const, capabilities: { 'schemanaut.data-notebook': { status: 'available' as const } } };
    const reason = 'data_profile and notebook_inspect are available; install jupyter externally and restart the Host after changing PATH to enable notebook_run.';
    return { status: 'degraded' as const, reason, capabilities: { 'schemanaut.data-notebook': { status: 'degraded' as const, reason } } };
  };
  const activate = async (): Promise<AgentCapabilityModuleRuntime> => {
    const tools: ToolInvocationContribution[] = [nativeTool('data_profile', 'Profile bounded JSON, JSONL, or CSV data.', profile, host), nativeTool('notebook_inspect', 'Inspect bounded metadata and cells from an ipynb file.', inspect, host)];
    if ((await host.executables.discover('jupyter')).status === 'available') tools.push(await notebookRun(host));
    return Object.freeze({ contributions: Object.freeze({ tools: Object.freeze(tools) }), close: () => Promise.resolve(undefined) });
  };
  return Object.freeze({ probe, activate, refresh: () => activate(), dispose: () => Promise.resolve(undefined) });
}

function nativeTool(name: 'data_profile' | 'notebook_inspect', description: string, operation: (path: string, context: ToolExecuteContext) => Promise<PortableValue>, host: FirstPartyCapabilityHost): ToolInvocationContribution {
  return Object.freeze({
    definition: Object.freeze({ name, description, inputSchema: source, outputSchema: { type: 'object' as const }, dangerLevel: 'safe' as const, readonly: true, source: 'first_party', exposure: 'direct', access: 'read' as const, recoveryClass: 'read' as const, toolRevision: `${name}@1`, handlerRevision: 'first-party-data@1', intentRevision: PREPARED_TOOL_INTENT_REVISION, limits: LIMITS, execution: { concurrency: 'read' as const, timeoutMs: LIMITS.timeoutMs }, failurePolicy: { onUnknown: { failureKind: 'unknown' as const, retryable: false } } }),
    runtime: Object.freeze({
      revision: Object.freeze({ toolName: name, toolRevision: `${name}@1`, handlerRevision: 'first-party-data@1', intentRevision: PREPARED_TOOL_INTENT_REVISION }),
      prepare: async (value: Readonly<Record<string, PortableValue>>, context: ToolPrepareContext) => prepareRead(value, context, read, host.workspaceRoot),
      execute: async (value: Readonly<Record<string, PortableValue>>, context: ToolExecuteContext) => {
        const target = preparedPathTarget(value.target);
        assertExecutionActive(context);
        const current = await prepareWorkspacePath(target.requestedPath, host.workspaceRoot);
        if (JSON.stringify(current) !== JSON.stringify(target)) throw new ToolExecutionError({ code: 'target_changed', category: 'precondition', retryable: true, outcome: 'not_applied' }, 'Data input changed after approval.');
        return operation(target.canonicalPath, context);
      },
    }),
  });
}

async function notebookRun(host: FirstPartyCapabilityHost): Promise<ToolInvocationContribution> {
  const operation: CommandCapabilityOperation = { name: 'notebook_run', description: 'Execute one workspace notebook with external Jupyter into one new workspace output path.', inputSchema: run, argv: value => ['nbconvert', '--to', 'notebook', '--execute', '--output', required(value.output, 'output'), required(value.input, 'input')], pathInputs: value => [required(value.input, 'input'), required(value.output, 'output')], permission: execute, output: 'stable-text' };
  const registration = createCommandCapabilityRegistration({ moduleId: 'schemanaut.data-notebook.run', capabilityId: 'schemanaut.data-notebook', instanceId: 'first-party-data-notebook-run', version: '1.0.0', description: operation.description, executables: ['jupyter'], operations: [operation] }, host);
  const tool = (await (await registration.load()).activate()).contributions.tools?.[0];
  if (!tool) throw expectedToolError('precondition', 'External jupyter CLI is unavailable.');
  return Object.freeze({ definition: tool.definition, runtime: Object.freeze({ ...tool.runtime, prepare: async (value: Readonly<Record<string, PortableValue>>, context: ToolPrepareContext) => {
    const output = required(value.output, 'output'); await assertAbsent(output, host.workspaceRoot); return tool.runtime.prepare(value, context);
  } }) });
}

async function prepareRead(value: Readonly<Record<string, PortableValue>>, context: ToolPrepareContext, permission: typeof read, workspaceRoot: string): Promise<PreparedToolIntent> {
  const target = await prepareWorkspacePath(required(value.input, 'input'), workspaceRoot);
  const facts: AgentToolPermissionFacts = { toolName: context.descriptor.flatName, dangerLevel: permission.dangerLevel, readonly: true, access: permission.access, recoveryClass: permission.recoveryClass, actions: permission.actions, paths: [target.canonicalPath], hosts: [], network: false, externalWrite: false, destructive: false, credentials: false, admin: false, unknownRisk: false, resolvedAddresses: [], targets: [{ kind: 'file', path: target.canonicalPath }] };
  return validatePreparedIntent({ input: { target }, targetIdentity: { kind: 'data-file', target }, runPolicy: context.runPolicy, generation: context.generation, toolRevision: context.toolRevision, handlerRevision: context.handlerRevision, intentRevision: PREPARED_TOOL_INTENT_REVISION, action: { summary: `Read ${context.descriptor.flatName}` }, permission: facts, access: facts.access, recoveryClass: facts.recoveryClass, concurrency: 'read', resourceKeys: [`file:${target.canonicalPath}`], limits: context.limits });
}

async function profile(path: string, context: ToolExecuteContext): Promise<PortableValue> {
  const text = await boundedRead(path, context); const extension = extname(path).toLowerCase();
  if (extension === '.json') { const value = parseJson(text); return { kind: 'json', bytes: Buffer.byteLength(text), root: Array.isArray(value) ? 'array' : typeof value, records: Array.isArray(value) ? Math.min(value.length, 2_000) : 1, depth: depth(value) }; }
  if (extension === '.jsonl' || extension === '.ndjson') { const lines = text.split(/\r?\n/u).filter(Boolean).slice(0, 2_000); for (const line of lines) parseJson(line); return { kind: 'jsonl', bytes: Buffer.byteLength(text), records: lines.length }; }
  const lines = text.split(/\r?\n/u).slice(0, 2_001); const columns = lines[0]?.split(',').slice(0, 128) ?? []; return { kind: 'csv', bytes: Buffer.byteLength(text), records: Math.max(0, lines.length - 1), columns: columns.length, headers: columns };
}
async function inspect(path: string, context: ToolExecuteContext): Promise<PortableValue> { const value = parseJson(await boundedRead(path, context)) as Record<string, unknown>; const cells = Array.isArray(value.cells) ? value.cells.slice(0, 2_000) : []; const cellTypes: Record<string, number> = {}; for (const cell of cells) { const record = cell !== null && typeof cell === 'object' && !Array.isArray(cell) ? cell as Record<string, PortableValue> : undefined; const type = typeof record?.cell_type === 'string' ? record.cell_type : 'unknown'; cellTypes[type] = (cellTypes[type] ?? 0) + 1; } return { kind: 'ipynb', cells: cells.length, cellTypes, nbformat: typeof value.nbformat === 'number' ? value.nbformat : null }; }
async function boundedRead(path: string, context: ToolExecuteContext): Promise<string> { assertExecutionActive(context); const info = await stat(path); assertExecutionActive(context); if (!info.isFile() || info.size > 1_048_576) throw expectedToolError('external', 'Data input is not a regular bounded file.', { outcome: 'not_applied' }); const text = await readFile(path, { encoding: 'utf8', signal: context.signal }); assertExecutionActive(context); return text; }
function parseJson(text: string): PortableValue { try { return JSON.parse(text) as PortableValue; } catch { throw expectedToolError('external', 'Data input is not valid JSON.', { outcome: 'not_applied' }); } }
function depth(value: PortableValue, current = 0): number { if (current >= 8 || value === null || typeof value !== 'object') return current; let maximum = current; for (const item of Array.isArray(value) ? value : Object.values(value)) maximum = Math.max(maximum, depth(item, current + 1)); return maximum; }
function required(value: unknown, label: string): string { if (typeof value !== 'string' || !value.trim() || value.length > 8192 || hasControlCodePoint(value)) throw expectedToolError('invalid_argument', `${label} is invalid.`); return value; }
async function prepareWorkspacePath(path: string, root: string): Promise<Awaited<ReturnType<typeof prepareProcessPath>>> { const workspace = resolve(root); const candidate = resolve(workspace, path); assertWorkspacePath(workspace, candidate); const [workspaceTarget, target] = await Promise.all([prepareProcessPath('.', workspace), prepareProcessPath(candidate, workspace)]); assertWorkspacePath(workspaceTarget.canonicalPath, target.canonicalPath); return target; }
function assertWorkspacePath(root: string, candidate: string): void { const outside = relative(resolve(root), resolve(candidate)); if (isAbsolute(outside) || outside === '..' || /^\.\.[\\/]/u.test(outside)) throw expectedToolError('invalid_argument', 'Data path must stay inside the workspace.'); }
function preparedPathTarget(value: PortableValue | undefined): Awaited<ReturnType<typeof prepareProcessPath>> { if (value === null || typeof value !== 'object' || Array.isArray(value)) throw expectedToolError('invalid_argument', 'Prepared data target is invalid.'); const target = value as Record<string, PortableValue>; const identity = target.identity; if (typeof target.requestedPath !== 'string' || typeof target.canonicalPath !== 'string' || typeof target.identityPath !== 'string' || identity === null || typeof identity !== 'object' || Array.isArray(identity)) throw expectedToolError('invalid_argument', 'Prepared data target is invalid.'); const identityRecord = identity as Record<string, PortableValue>; if (typeof identityRecord.dev !== 'string' || typeof identityRecord.ino !== 'string') throw expectedToolError('invalid_argument', 'Prepared data target is invalid.'); return target as unknown as Awaited<ReturnType<typeof prepareProcessPath>>; }
function assertExecutionActive(context: ToolExecuteContext): void { if (context.signal.aborted) throw new ToolExecutionError({ code: 'TOOL_CANCELLED', category: 'cancelled', retryable: false, outcome: 'not_applied' }, 'Data operation was cancelled.'); if (!Number.isFinite(Date.parse(context.deadline)) || Date.parse(context.deadline) <= Date.now()) throw new ToolExecutionError({ code: 'TOOL_TIMEOUT', category: 'timeout', retryable: true, outcome: 'not_applied' }, 'Data operation deadline expired.'); }
async function assertAbsent(path: string, root: string): Promise<void> { const candidate = resolve(root, path); try { await lstat(candidate); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; } throw expectedToolError('precondition', 'Notebook output already exists; choose an explicit new path.'); }
