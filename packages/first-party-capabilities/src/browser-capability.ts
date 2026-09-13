import { constants } from 'node:fs';
import { lstat, open, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import {
  PREPARED_TOOL_INTENT_REVISION,
  ToolExecutionError,
  expectedToolError,
  validatePreparedIntent,
  type AgentCapabilityLifecycleContext,
  type AgentCapabilityModule,
  type AgentCapabilityModuleRegistration,
  type AgentCapabilityModuleRuntime,
  type AgentCapabilityProbeResult,
  type AgentToolPermissionFacts,
  type InvocationLimits,
  type PreparedToolIntent,
  type ToolExecuteContext,
  type ToolInvocationContribution,
  type ToolPrepareContext,
} from '@dbagent/core-agent';
import { prepareProcessPath, type ExecutableDiscoveryResult, type ProcessPathTarget } from '@dbagent/core-tools';
import { assertPortableValue, type PortableValue } from '@dbagent/shared';
import {
  BrowserSessionError,
  type BrowserInteraction,
  type BrowserOperationContext,
  type BrowserPageRef,
  type BrowserSessionConnection,
  type BrowserSessionPort,
} from './browser-session-port.js';
import type { FirstPartyCapabilityHost } from './types.js';
import { hasControlCodePoint } from './input-validation.js';

export type BrowserCapabilityHost = FirstPartyCapabilityHost & Readonly<{ browser: BrowserSessionPort }>;

const LIMITS: InvocationLimits = Object.freeze({ timeoutMs: 60_000, maxInputBytes: 65_536, maxOutputBytes: 2_097_152, maxArtifactBytes: 32_000_000, maxDepth: 8, maxRecords: 1_024 });
const TEST_LIMITS: InvocationLimits = Object.freeze({ timeoutMs: 600_000, maxInputBytes: 32_768, maxOutputBytes: 1_048_576, maxArtifactBytes: 1_048_576, maxDepth: 8, maxRecords: 512 });
const VERSION = '1.0.0';
const MODULE_ID = 'schemanaut.browser';

type PlaywrightExecutable = Extract<ExecutableDiscoveryResult, { status: 'available' }>;
type BrowserRuntimeState = Readonly<{ connection?: BrowserSessionConnection; playwright?: PlaywrightExecutable; generation: string }>;
type BrowserOperationName = 'browser_navigate' | 'browser_read' | 'browser_click' | 'browser_type_or_interact' | 'browser_screenshot';
type BrowserPermission = Pick<AgentToolPermissionFacts, 'access' | 'recoveryClass' | 'dangerLevel' | 'actions' | 'network' | 'externalWrite' | 'destructive' | 'admin' | 'unknownRisk'> & Readonly<{ readonly: boolean; concurrency: 'read' | 'write' | 'exclusive' }>;

/** Browser authentication remains inside the Host-owned external browser session. */
export function createBrowserCapability(host: BrowserCapabilityHost): AgentCapabilityModuleRegistration {
  let generation = 0;
  return Object.freeze({
    manifest: Object.freeze({ id: MODULE_ID, version: VERSION, description: 'Navigate, read, interact with, screenshot, and test pages through a Host-owned browser session.', capabilities: Object.freeze([{ id: MODULE_ID, description: 'Authenticated external browser session and optional external Playwright tests.' }]) }),
    instanceId: 'first-party-browser',
    load: () => Promise.resolve(createModule(host, () => `${MODULE_ID}:${++generation}`)),
  });
}

function createModule(host: BrowserCapabilityHost, nextGeneration: () => string): AgentCapabilityModule {
  const availability = async (context?: AgentCapabilityLifecycleContext) => {
    const operation = lifecycleContext(context);
    const [browser, playwright] = await Promise.all([
      host.browser.probe(operation).catch(error => {
        if (error instanceof BrowserSessionError && (error.kind === 'cancelled' || error.kind === 'timeout')) throw mapBrowserError(error);
        return { status: 'unavailable' as const, reason: error instanceof Error ? error.message : 'Browser session is unavailable.' };
      }),
      host.executables.discover('playwright').catch(() => ({ status: 'unavailable', reason: 'not_found', diagnostic: 'Install Playwright externally.' } as const)),
    ]);
    return { browser, playwright };
  };
  const build = async (context?: AgentCapabilityLifecycleContext): Promise<AgentCapabilityModuleRuntime> => {
    const found = await availability(context);
    const playwright = found.playwright.status === 'available' ? found.playwright : undefined;
    let connection: BrowserSessionConnection | undefined;
    if (found.browser.status === 'available') connection = await invokeBrowser(() => host.browser.connect(lifecycleContext(context)));
    if (!connection && !playwright) throw expectedToolError('precondition', availabilityReason(found));
    const state: BrowserRuntimeState = Object.freeze({ ...(connection ? { connection } : {}), ...(playwright ? { playwright } : {}), generation: nextGeneration() });
    return Object.freeze({ contributions: Object.freeze({ tools: Object.freeze([
      ...(connection ? browserSessionContributions(host, state) : []),
      ...(playwright ? [browserTestContribution(host, state, playwright)] : []),
    ]) }) });
  };
  return Object.freeze({
    probe: async (context?: AgentCapabilityLifecycleContext): Promise<AgentCapabilityProbeResult> => {
      const found = await availability(context);
      const browser = found.browser.status === 'available';
      const playwright = found.playwright.status === 'available';
      const status = browser ? (playwright ? 'available' : 'degraded') : playwright ? 'degraded' : 'unavailable';
      const reason = status === 'available' ? undefined : availabilityReason(found);
      return Object.freeze({ status, ...(reason ? { reason } : {}), capabilities: Object.freeze({ [MODULE_ID]: Object.freeze({ status, ...(reason ? { reason } : {}) }) }) });
    },
    activate: build,
    refresh: async (_current, context) => build(context),
    dispose: async context => invokeBrowser(() => host.browser.close(lifecycleContext(context))),
  });
}

function browserSessionContributions(host: BrowserCapabilityHost, state: BrowserRuntimeState): readonly ToolInvocationContribution[] {
  return Object.freeze([
    browserContribution(host, state, 'browser_navigate', 'Navigate the attached browser page to an HTTP(S) URL.', navigateSchema, permissions.navigate, async (input, context) => {
      const result = await invokeBrowser(() => host.browser.navigate(optionalPageRef(input.pageRef), requiredUrl(input.url), operationContext(context)));
      return browserActionProjection(result);
    }),
    browserContribution(host, state, 'browser_read', 'Read a bounded visible-text and interactive-element projection of an attached page.', pageSchema, permissions.read, async (input, context) => {
      const result = await invokeBrowser(() => host.browser.read(requiredPageRef(input.pageRef), operationContext(context)));
      return Object.freeze({ ...result, elements: result.elements.map(item => ({ ...item })) });
    }),
    browserContribution(host, state, 'browser_click', 'Click an element in the attached browser page by an explicit selector.', selectorSchema, permissions.click, async (input, context) => {
      const result = await invokeBrowser(() => host.browser.click(requiredPageRef(input.pageRef), requiredText(input.selector, 'selector', 4_096), operationContext(context)));
      return browserActionProjection(result);
    }),
    browserContribution(host, state, 'browser_type_or_interact', 'Type, press a key, select, check, uncheck, or focus an explicit page element.', interactionSchema, permissions.interact, async (input, context) => {
      const interaction = requiredInteraction(input);
      const result = await invokeBrowser(() => host.browser.interact(requiredPageRef(input.pageRef), interaction, operationContext(context)));
      return browserActionProjection(result);
    }),
    screenshotContribution(host, state),
  ]);
}

function browserContribution(
  _host: BrowserCapabilityHost,
  state: BrowserRuntimeState,
  name: Exclude<BrowserOperationName, 'browser_screenshot'>,
  description: string,
  inputSchema: Readonly<Record<string, unknown>>,
  permission: BrowserPermission,
  execute: (input: Readonly<Record<string, PortableValue>>, context: ToolExecuteContext) => Promise<PortableValue>,
): ToolInvocationContribution {
  return contribution(name, description, inputSchema, permission, LIMITS,
    (input, context) => Promise.resolve(browserIntent(name, input, context, state, permission)),
    execute);
}

function screenshotContribution(host: BrowserCapabilityHost, state: BrowserRuntimeState): ToolInvocationContribution {
  const name = 'browser_screenshot' as const; const permission = permissions.screenshot;
  return contribution(name, 'Capture the attached page to a new PNG file inside the workspace.', screenshotSchema, permission, LIMITS,
    async (input, context) => {
      const raw = asRecord(input); const outputPath = requiredText(raw.outputPath, 'outputPath', 8_192);
      const target = await prepareNewWorkspaceFile(outputPath, host.workspaceRoot);
      return browserIntent(name, { pageRef: optionalPageRef(raw.pageRef), fullPage: raw.fullPage === true, outputPath: target.canonicalPath, outputTarget: target }, context, state, permission, [target.canonicalPath], [`file:${target.canonicalPath}`]);
    },
    async (input, context) => {
      const target = processPathTarget(input.outputTarget as PortableValue); await assertPreparedPath(target, host.workspaceRoot);
      const screenshot = await invokeBrowser(() => host.browser.screenshot(requiredPageRef(input.pageRef), input.fullPage === true, operationContext(context)));
      if (screenshot.bytes.byteLength > context.intent.limits.maxArtifactBytes) throw expectedToolError('limit', 'Browser screenshot exceeds the Tool artifact limit.', { outcome: 'not_applied' });
      await writeNewFile(target.canonicalPath, screenshot.bytes);
      return Object.freeze({ status: 'ok', path: target.canonicalPath, mediaType: screenshot.mediaType, sizeBytes: screenshot.bytes.byteLength, sessionRef: screenshot.sessionRef, pageRef: screenshot.pageRef, url: screenshot.url, title: screenshot.title });
    });
}

function browserTestContribution(host: BrowserCapabilityHost, state: BrowserRuntimeState, executable: PlaywrightExecutable): ToolInvocationContribution {
  const name = 'browser_test';
  const permission: BrowserPermission = permissions.test;
  return contribution(name, 'Run one explicit workspace Playwright test file using the externally installed Playwright CLI.', testSchema, permission, TEST_LIMITS,
    async (input, context) => {
      const raw = asRecord(input); const target = await prepareExistingWorkspaceFile(requiredText(raw.testPath, 'testPath', 8_192), host.workspaceRoot);
      return host.command.prepare({ executable: executable.launch, argv: ['test', target.canonicalPath], cwd: host.workspaceRoot, pathTargets: [target], hostTargets: [], requested: { network: true, externalWrite: true, destructive: true, credentials: false, admin: false, unknownRisk: true }, permission: { access: permission.access, recoveryClass: permission.recoveryClass, dangerLevel: permission.dangerLevel, actions: permission.actions }, resourceKeys: [`first-party:${name}`, `generation:${state.generation}`, `file:${target.canonicalPath}`], timeoutMs: TEST_LIMITS.timeoutMs, limits: TEST_LIMITS }, context);
    },
    async (input, context) => {
      const result = await host.command.execute(input, context);
      assertPortableValue(result);
      return result;
    });
}

function contribution(
  name: string,
  description: string,
  inputSchema: Readonly<Record<string, unknown>>,
  permission: BrowserPermission,
  limits: InvocationLimits,
  prepare: (input: Readonly<Record<string, PortableValue>>, context: ToolPrepareContext) => Promise<PreparedToolIntent>,
  execute: (input: Readonly<Record<string, PortableValue>>, context: ToolExecuteContext) => Promise<PortableValue>,
): ToolInvocationContribution {
  const toolRevision = `${name}@1`; const handlerRevision = 'first-party-browser-handler@1';
  return Object.freeze({
    definition: Object.freeze({ name, description, inputSchema, outputSchema: { type: 'object' as const }, dangerLevel: permission.dangerLevel, readonly: permission.readonly, source: 'first_party', exposure: 'direct', access: permission.access, recoveryClass: permission.recoveryClass, toolRevision, handlerRevision, intentRevision: PREPARED_TOOL_INTENT_REVISION, limits, execution: { concurrency: permission.concurrency, timeoutMs: limits.timeoutMs }, failurePolicy: { onUnknown: { failureKind: 'unknown' as const, retryable: false } } }),
    runtime: Object.freeze({ revision: Object.freeze({ toolName: name, toolRevision, handlerRevision, intentRevision: PREPARED_TOOL_INTENT_REVISION }), prepare, execute }),
  });
}

function browserIntent(
  name: BrowserOperationName,
  input: Readonly<Record<string, unknown>>,
  context: ToolPrepareContext,
  state: BrowserRuntimeState,
  permission: BrowserPermission,
  paths: readonly string[] = [],
  extraKeys: readonly string[] = [],
): PreparedToolIntent {
  if (!state.connection) throw expectedToolError('precondition', 'The authenticated browser session is not connected.');
  const preparedInput = cleanBrowserInput(input);
  const pageRef = optionalPageRef(preparedInput.pageRef);
  if (name !== 'browser_navigate' && !pageRef) throw expectedToolError('invalid_argument', 'pageRef is required; call browser_navigate first to obtain one.');
  const hosts = name === 'browser_navigate' && typeof preparedInput.url === 'string' ? [new URL(preparedInput.url).hostname] : [];
  const facts: AgentToolPermissionFacts = Object.freeze({ toolName: context.descriptor.flatName, dangerLevel: permission.dangerLevel, readonly: permission.readonly, access: permission.access, recoveryClass: permission.recoveryClass, actions: permission.actions, paths: [...paths], hosts, network: permission.network, externalWrite: permission.externalWrite, destructive: permission.destructive, credentials: false, admin: permission.admin, unknownRisk: permission.unknownRisk, resolvedAddresses: [], targets: [{ kind: 'browser-page', sessionRef: state.connection.sessionRef, ...(pageRef ? { pageRef } : {}) }] });
  return validatePreparedIntent({ input: preparedInput, targetIdentity: null, runPolicy: context.runPolicy, generation: context.generation, toolRevision: context.toolRevision, handlerRevision: context.handlerRevision, intentRevision: PREPARED_TOOL_INTENT_REVISION, action: { summary: browserActionSummary(name) }, permission: facts, access: facts.access, recoveryClass: facts.recoveryClass, concurrency: permission.concurrency, resourceKeys: [...new Set([`browser:${state.connection.sessionRef}`, ...(pageRef ? [`browser-page:${pageRef}`] : []), ...extraKeys])], limits: context.limits });
}

const permissions = Object.freeze({
  navigate: Object.freeze({ access: 'external' as const, recoveryClass: 'idempotent' as const, dangerLevel: 'medium' as const, readonly: false, actions: Object.freeze(['execute', 'network'] as const), network: true, externalWrite: false, destructive: false, admin: false, unknownRisk: false, concurrency: 'exclusive' as const }),
  read: Object.freeze({ access: 'external' as const, recoveryClass: 'read' as const, dangerLevel: 'medium' as const, readonly: true, actions: Object.freeze(['read', 'network'] as const), network: true, externalWrite: false, destructive: false, admin: false, unknownRisk: false, concurrency: 'exclusive' as const }),
  click: Object.freeze({ access: 'external' as const, recoveryClass: 'non_idempotent' as const, dangerLevel: 'high' as const, readonly: false, actions: Object.freeze(['write', 'network', 'unknown'] as const), network: true, externalWrite: true, destructive: false, admin: false, unknownRisk: true, concurrency: 'exclusive' as const }),
  interact: Object.freeze({ access: 'external' as const, recoveryClass: 'non_idempotent' as const, dangerLevel: 'high' as const, readonly: false, actions: Object.freeze(['write', 'network', 'unknown'] as const), network: true, externalWrite: true, destructive: false, admin: false, unknownRisk: true, concurrency: 'exclusive' as const }),
  screenshot: Object.freeze({ access: 'write' as const, recoveryClass: 'idempotent' as const, dangerLevel: 'high' as const, readonly: false, actions: Object.freeze(['read', 'write', 'network'] as const), network: true, externalWrite: false, destructive: false, admin: false, unknownRisk: false, concurrency: 'exclusive' as const }),
  test: Object.freeze({ access: 'destructive' as const, recoveryClass: 'non_idempotent' as const, dangerLevel: 'high' as const, readonly: false, actions: Object.freeze(['read', 'write', 'execute', 'network', 'delete', 'unknown'] as const), network: true, externalWrite: true, destructive: true, admin: false, unknownRisk: true, concurrency: 'exclusive' as const }),
});

const pageRefProperty = { type: 'string', minLength: 1, maxLength: 256 } as const;
const pageSchema = { type: 'object', additionalProperties: false, required: ['pageRef'], properties: { pageRef: pageRefProperty } } as const;
const navigateSchema = { type: 'object', additionalProperties: false, required: ['url'], properties: { pageRef: pageRefProperty, url: { type: 'string', minLength: 1, maxLength: 8192 } } } as const;
const selectorSchema = { type: 'object', additionalProperties: false, required: ['pageRef', 'selector'], properties: { pageRef: pageRefProperty, selector: { type: 'string', minLength: 1, maxLength: 4096 } } } as const;
const interactionSchema = { type: 'object', additionalProperties: false, required: ['pageRef', 'kind', 'selector'], properties: { pageRef: pageRefProperty, kind: { type: 'string', enum: ['type', 'press', 'select', 'check', 'uncheck', 'focus'] }, selector: { type: 'string', minLength: 1, maxLength: 4096 }, value: { type: 'string', maxLength: 32768 } } } as const;
const screenshotSchema = { type: 'object', additionalProperties: false, required: ['pageRef', 'outputPath'], properties: { pageRef: pageRefProperty, outputPath: { type: 'string', minLength: 1, maxLength: 8192 }, fullPage: { type: 'boolean' } } } as const;
const testSchema = { type: 'object', additionalProperties: false, required: ['testPath'], properties: { testPath: { type: 'string', minLength: 1, maxLength: 8192 } } } as const;

function asRecord(value: unknown): Readonly<Record<string, unknown>> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw expectedToolError('invalid_argument', 'Browser Tool input must be an object.'); return value as Readonly<Record<string, unknown>>; }
function requiredText(value: unknown, label: string, maximum: number): string { if (typeof value !== 'string' || !value.trim() || value.length > maximum || hasControlCodePoint(value)) throw expectedToolError('invalid_argument', `${label} is invalid.`); return value; }
function optionalPageRef(value: unknown): BrowserPageRef | undefined { if (value === undefined) return undefined; const text = requiredText(value, 'pageRef', 256); if (!/^browser-page:[0-9a-f-]{36}$/iu.test(text)) throw expectedToolError('invalid_argument', 'pageRef is invalid.'); return text as BrowserPageRef; }
function requiredPageRef(value: unknown): BrowserPageRef { const ref = optionalPageRef(value); if (!ref) throw expectedToolError('invalid_argument', 'pageRef is required; call browser_navigate first to obtain one.'); return ref; }
function requiredUrl(value: unknown): string { const text = requiredText(value, 'url', 8_192); let url: URL; try { url = new URL(text); } catch { throw expectedToolError('invalid_argument', 'url must be an absolute HTTP(S) URL.'); } if (!['http:', 'https:'].includes(url.protocol)) throw expectedToolError('invalid_argument', 'url must be an HTTP(S) URL.'); return url.toString(); }
function requiredInteraction(input: Readonly<Record<string, PortableValue>>): BrowserInteraction { const raw = asRecord(input); const kind = raw.kind; if (!['type', 'press', 'select', 'check', 'uncheck', 'focus'].includes(String(kind))) throw expectedToolError('invalid_argument', 'interaction kind is invalid.'); const value = raw.value === undefined ? undefined : requiredText(raw.value, 'value', 32_768); if (['type', 'press', 'select'].includes(String(kind)) && value === undefined) throw expectedToolError('invalid_argument', 'This interaction requires a value.'); return Object.freeze({ kind: kind as BrowserInteraction['kind'], selector: requiredText(raw.selector, 'selector', 4_096), ...(value === undefined ? {} : { value }) }); }
function cleanBrowserInput(input: Readonly<Record<string, unknown>>): Readonly<Record<string, PortableValue>> { const raw = asRecord(input); const result: Record<string, PortableValue> = {}; if (raw.pageRef !== undefined) result.pageRef = optionalPageRef(raw.pageRef)!; if (raw.url !== undefined) result.url = requiredUrl(raw.url); if (raw.selector !== undefined) result.selector = requiredText(raw.selector, 'selector', 4_096); if (raw.kind !== undefined) result.kind = requiredText(raw.kind, 'kind', 32); if (raw.value !== undefined) result.value = requiredText(raw.value, 'value', 32_768); if (raw.outputPath !== undefined) result.outputPath = requiredText(raw.outputPath, 'outputPath', 8_192); if (raw.outputTarget !== undefined) result.outputTarget = raw.outputTarget as PortableValue; if (raw.fullPage !== undefined) result.fullPage = raw.fullPage === true; return Object.freeze(result); }
function browserActionProjection(value: Readonly<{ sessionRef: string; pageRef: string; url: string; title: string }>): PortableValue { return Object.freeze({ sessionRef: value.sessionRef, pageRef: value.pageRef, url: value.url, title: value.title }); }
function browserActionSummary(name: BrowserOperationName): string { return ({ browser_navigate: 'Navigate the attached browser page.', browser_read: 'Read the attached browser page.', browser_click: 'Click the attached browser page.', browser_type_or_interact: 'Interact with the attached browser page.', browser_screenshot: 'Capture the attached browser page to a workspace file.' })[name]; }
function lifecycleContext(context?: Readonly<{ signal: AbortSignal; deadline?: string }>): BrowserOperationContext | undefined { return context ? Object.freeze({ signal: context.signal, ...(context.deadline ? { deadline: context.deadline } : {}) }) : undefined; }
function operationContext(context: ToolExecuteContext): BrowserOperationContext { return Object.freeze({ signal: context.signal, deadline: context.deadline }); }
function availabilityReason(found: Readonly<{ browser: Readonly<{ status: string; reason?: string }>; playwright: ExecutableDiscoveryResult }>): string { const browser = found.browser.status === 'available' ? undefined : found.browser.reason ?? 'Start a local Chrome/Edge CDP session after signing in outside SchemaNaut.'; const playwright = found.playwright.status === 'available' ? undefined : 'Install Playwright externally for browser_test.'; return [browser, playwright].filter((item): item is string => Boolean(item)).join(' '); }
async function invokeBrowser<T>(operation: () => Promise<T>): Promise<T> { try { return await operation(); } catch (error) { throw mapBrowserError(error); } }
function mapBrowserError(error: unknown): Error { if (!(error instanceof BrowserSessionError)) return expectedToolError('external', error instanceof Error ? error.message : 'Browser operation failed.', { outcome: 'unknown' }); if (error.kind === 'timeout') return new ToolExecutionError({ code: 'TOOL_TIMEOUT', category: 'timeout', retryable: true, outcome: 'unknown' }, error.message); if (error.kind === 'cancelled') return new ToolExecutionError({ code: 'TOOL_CANCELLED', category: 'cancelled', retryable: false, outcome: 'unknown' }, error.message); return expectedToolError(error.kind, error.message, { outcome: error.kind === 'external' ? 'unknown' : 'not_applied' }); }

async function prepareNewWorkspaceFile(path: string, root: string): Promise<ProcessPathTarget> { const target = await prepareWorkspacePath(path, root); try { await lstat(target.canonicalPath); throw expectedToolError('conflict', 'The screenshot output already exists; choose a new file.'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } return target; }
async function prepareExistingWorkspaceFile(path: string, root: string): Promise<ProcessPathTarget> { const target = await prepareWorkspacePath(path, root); const details = await stat(target.canonicalPath).catch(() => undefined); if (!details?.isFile()) throw expectedToolError('not_found', 'The browser test path must identify an existing workspace file.'); return target; }
async function prepareWorkspacePath(path: string, root: string): Promise<ProcessPathTarget> { const workspace = resolve(root); const candidate = resolve(workspace, path); assertWorkspacePath(workspace, candidate); try { const [workspaceTarget, target] = await Promise.all([prepareProcessPath('.', workspace), prepareProcessPath(candidate, workspace)]); assertWorkspacePath(workspaceTarget.canonicalPath, target.canonicalPath); return target; } catch (error) { if (error instanceof Error && error.name === 'ToolExecutionError') throw error; throw expectedToolError('precondition', 'The workspace path identity could not be prepared.'); } }
function assertWorkspacePath(root: string, candidate: string): void { const outside = relative(resolve(root), resolve(candidate)); if (isAbsolute(outside) || outside === '..' || /^\.\.[\\/]/u.test(outside)) throw expectedToolError('invalid_argument', 'The path must stay inside the workspace.'); }
function processPathTarget(value: PortableValue): ProcessPathTarget { if (!value || typeof value !== 'object' || Array.isArray(value)) throw expectedToolError('precondition', 'The prepared screenshot target is unavailable.'); const target = value as Record<string, unknown>; if (typeof target.requestedPath !== 'string' || typeof target.canonicalPath !== 'string' || typeof target.identityPath !== 'string' || !target.identity || typeof target.identity !== 'object') throw expectedToolError('precondition', 'The prepared screenshot target is invalid.'); return target as unknown as ProcessPathTarget; }
async function assertPreparedPath(expected: ProcessPathTarget, root: string): Promise<void> { const current = await prepareWorkspacePath(expected.requestedPath, root); if (JSON.stringify(current) !== JSON.stringify(expected)) throw new ToolExecutionError({ code: 'target_changed', category: 'precondition', retryable: true, outcome: 'not_applied' }, 'The screenshot target changed after approval; prepare again.'); }
async function writeNewFile(path: string, bytes: Uint8Array): Promise<void> { let handle; try { handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600); await handle.writeFile(bytes); await handle.sync(); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST' || (error as NodeJS.ErrnoException).code === 'ELOOP') throw new ToolExecutionError({ code: 'target_changed', category: 'precondition', retryable: true, outcome: 'not_applied' }, 'The screenshot output target changed or already exists; prepare again.'); throw expectedToolError('external', error instanceof Error ? error.message : 'Could not write the screenshot file.', { outcome: 'unknown' }); } finally { await handle?.close(); } }
