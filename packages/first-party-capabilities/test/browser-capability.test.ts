import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PreparedToolIntent, ToolExecuteContext, ToolPrepareContext } from '@dbagent/core-agent';
import type { PREPARED_TOOL_INTENT_REVISION } from '@dbagent/core-agent';
import { createBrowserCapability, type BrowserCapabilityHost } from '../src/browser-capability.js';
import { CdpBrowserSessionConnector, type BrowserWebSocket } from '../src/browser-connector.js';
import type { BrowserPageRef, BrowserSessionPort, BrowserSessionRef } from '../src/browser-session-port.js';
import { available, unavailable } from './helpers.js';

const sessionRef = 'browser-session:11111111-1111-4111-8111-111111111111' as BrowserSessionRef;
const pageRef = 'browser-page:22222222-2222-4222-8222-222222222222' as BrowserPageRef;
const roots: string[] = [];

afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

function browser(status: 'available' | 'unavailable' = 'available'): BrowserSessionPort {
  return {
    probe: () => Promise.resolve(status === 'available' ? { status, browser: 'Chrome' } : { status, reason: 'Start a local browser session.' }),
    connect: () => Promise.resolve({ sessionRef, pages: [{ pageRef, url: 'https://example.test', title: 'Example' }] }),
    navigate: (_page, url) => Promise.resolve({ sessionRef, pageRef, url, title: 'Navigated' }),
    read: () => Promise.resolve({ sessionRef, pageRef, url: 'https://example.test', title: 'Example', text: 'Visible page', elements: [], truncated: false }),
    click: () => Promise.resolve({ sessionRef, pageRef, url: 'https://example.test', title: 'Clicked' }),
    interact: () => Promise.resolve({ sessionRef, pageRef, url: 'https://example.test', title: 'Interacted' }),
    screenshot: () => Promise.resolve({ sessionRef, pageRef, url: 'https://example.test', title: 'Example', mediaType: 'image/png', bytes: Uint8Array.from([1, 2, 3]) }),
    close: () => Promise.resolve(),
  };
}

function cookieBearingConnector(): BrowserSessionPort {
  const listeners = new Map<string, Set<(event: { data?: unknown }) => void>>();
  const socket: BrowserWebSocket = {
    readyState: 1,
    addEventListener(type, listener) { const registered = listeners.get(type) ?? new Set(); registered.add(listener); listeners.set(type, registered); },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    close() { for (const listener of listeners.get('close') ?? []) listener({}); },
    send(data) {
      const command = JSON.parse(data) as { id: number; method: string; params?: { expression?: string } };
      const expression = command.params?.expression ?? '';
      const result = command.method === 'Target.createTarget' ? { targetId: 'dedicated-target' }
        : command.method === 'Target.attachToTarget' ? { sessionId: 'cdp-session' }
          : command.method === 'Runtime.evaluate' ? { result: { value: expression === 'document.readyState' ? 'complete' : { url: 'https://example.test/account', title: 'Account' } } }
            : {};
      queueMicrotask(() => { for (const listener of listeners.get('message') ?? []) listener({ data: JSON.stringify({ id: command.id, result }) }); });
    },
  };
  return new CdpBrowserSessionConnector({
    endpoint: 'http://127.0.0.1:9222',
    fetch: () => Promise.resolve(new Response(
      JSON.stringify({ Browser: 'Chrome/140', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/private-id' }),
      { status: 200, headers: { 'Set-Cookie': 'browser-private=session-cookie' } },
    )),
    webSocketFactory: () => socket,
  });
}

type BrowserTool = { definition: { name: string; toolRevision: string; handlerRevision: string; intentRevision: string; limits: ToolPrepareContext['limits']; readonly?: boolean; access: ToolPrepareContext['descriptor']['access']; recoveryClass: ToolPrepareContext['descriptor']['recoveryClass']; dangerLevel: ToolPrepareContext['descriptor']['dangerLevel'] } };

function context(tool: BrowserTool): ToolPrepareContext {
  return {
    hostId: 'host', projectId: 'project', sessionId: 'session', runId: 'run', turnId: 'turn', invocationId: 'invocation', idempotencyKey: 'key',
    runtimeState: {} as never, discoverableTools: [], discoverableCapabilities: [], signal: new AbortController().signal,
    runPolicy: { mode: 'default', revision: 'run-policy.v1' }, generation: 'browser-generation@1',
    descriptor: { flatName: tool.definition.name, id: { name: tool.definition.name }, description: '', aliases: [], tags: [], inputSchema: {}, outputSchema: {}, source: 'first_party', exposure: 'deferred', execution: { concurrency: 'exclusive', timeoutMs: tool.definition.limits.timeoutMs }, failurePolicy: { onUnknown: { failureKind: 'unknown', retryable: false } }, ...tool.definition } as never,
    toolRevision: tool.definition.toolRevision, handlerRevision: tool.definition.handlerRevision, intentRevision: tool.definition.intentRevision as typeof PREPARED_TOOL_INTENT_REVISION, limits: tool.definition.limits,
  };
}

function executeContext(intent: PreparedToolIntent): ToolExecuteContext {
  return { hostId: 'host', projectId: 'project', sessionId: 'session', runId: 'run', turnId: 'turn', invocationId: 'invocation', idempotencyKey: 'key', runtimeState: {} as never, discoverableTools: [], discoverableCapabilities: [], signal: new AbortController().signal, intent, deadline: new Date(Date.now() + 60_000).toISOString() } as unknown as ToolExecuteContext;
}

function capabilityHost(root: string, options: { browser?: BrowserSessionPort; playwright?: boolean; command?: unknown } = {}): BrowserCapabilityHost {
  return { workspaceRoot: root, browser: options.browser ?? browser(), executables: { discover: name => Promise.resolve(name === 'playwright' && options.playwright ? available() : unavailable()) }, command: (options.command ?? {}) as BrowserCapabilityHost['command'] };
}

describe('Browser capability', () => {
  it('publishes page actions without Cookie, header, Authorization, or endpoint inputs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'browser-capability-')); roots.push(root);
    const module = await createBrowserCapability(capabilityHost(root)).load();
    const tools = (await module.activate()).contributions.tools ?? [];
    expect(tools.map(tool => tool.definition.name)).toEqual(['browser_navigate', 'browser_read', 'browser_click', 'browser_type_or_interact', 'browser_screenshot']);
    const schemas = JSON.stringify(tools.map(tool => tool.definition.inputSchema));
    expect(schemas).not.toMatch(/cookie|set-cookie|authorization|api.?header|cdp|endpoint|storage/i);

    const navigate = tools.find(tool => tool.definition.name === 'browser_navigate')!;
    const prepared = await navigate.runtime.prepare({ url: 'https://example.test/account' }, context(navigate));
    const result = await navigate.runtime.execute(prepared.input, executeContext(prepared));
    expect(prepared.permission).toMatchObject({ network: true, credentials: false, hosts: ['example.test'], externalWrite: false });
    expect(JSON.stringify({ prepared, result })).not.toMatch(/cookie|set-cookie|authorization|browser-private/i);
    await expect(navigate.runtime.prepare({ url: 'https://user:pass@example.test/private' }, context(navigate))).resolves.toMatchObject({
      permission: { hosts: ['example.test'] },
    });

    const click = tools.find(tool => tool.definition.name === 'browser_click')!;
    const clickIntent = await click.runtime.prepare({ pageRef, selector: '#save' }, context(click));
    expect(clickIntent.permission).toMatchObject({ dangerLevel: 'high', externalWrite: true, unknownRisk: true, credentials: false });
    const read = tools.find(tool => tool.definition.name === 'browser_read')!;
    expect(() => read.runtime.prepare({}, context(read))).toThrow('pageRef is required');
  });

  it('keeps a connector Set-Cookie response outside Agent-visible prepared input and result', async () => {
    const root = await mkdtemp(join(tmpdir(), 'browser-capability-')); roots.push(root);
    const module = await createBrowserCapability(capabilityHost(root, { browser: cookieBearingConnector() })).load();
    const navigate = (await module.activate()).contributions.tools?.find(tool => tool.definition.name === 'browser_navigate');
    expect(navigate).toBeDefined();
    if (!navigate) throw new Error('browser_navigate was not contributed');
    const prepared = await navigate.runtime.prepare({ url: 'https://example.test/account' }, context(navigate));
    const result = await navigate.runtime.execute(prepared.input, executeContext(prepared));

    expect(JSON.stringify({ prepared, result })).not.toMatch(/cookie|set-cookie|header|authorization|private-id|session-cookie/i);
  });

  it('writes a screenshot once and refuses implicit overwrite', async () => {
    const root = await mkdtemp(join(tmpdir(), 'browser-capability-')); roots.push(root);
    const module = await createBrowserCapability(capabilityHost(root)).load();
    const screenshot = (await module.activate()).contributions.tools?.find(tool => tool.definition.name === 'browser_screenshot');
    expect(screenshot).toBeDefined();
    if (!screenshot) throw new Error('browser_screenshot was not contributed');
    const prepared = await screenshot.runtime.prepare({ pageRef, outputPath: 'shot.png', fullPage: true }, context(screenshot));
    const result = await screenshot.runtime.execute(prepared.input, executeContext(prepared));
    expect(result).toMatchObject({ status: 'ok', sizeBytes: 3, path: join(root, 'shot.png') });
    expect([...await readFile(join(root, 'shot.png'))]).toEqual([1, 2, 3]);
    await expect(screenshot.runtime.prepare({ pageRef, outputPath: 'shot.png' }, context(screenshot))).rejects.toThrow('already exists');
    const raced = await screenshot.runtime.prepare({ pageRef, outputPath: 'raced.png' }, context(screenshot));
    await writeFile(join(root, 'raced.png'), 'replacement');
    await expect(screenshot.runtime.execute(raced.input, executeContext(raced))).rejects.toThrow('changed after approval');
  });

  it('publishes only the unauthenticated Playwright fallback when no shared browser session is available', async () => {
    const root = await mkdtemp(join(tmpdir(), 'browser-capability-')); roots.push(root);
    await writeFile(join(root, 'page.spec.ts'), 'test("page", async () => {})');
    const preparedCommands: Array<Record<string, unknown>> = [];
    const module = await createBrowserCapability(capabilityHost(root, { browser: browser('unavailable'), playwright: true, command: { prepare: (input: Record<string, unknown>) => { preparedCommands.push(input); return Promise.resolve({} as PreparedToolIntent); } } })).load();
    const probe = await module.probe?.();
    expect(probe?.status).toBe('degraded');
    const tools = (await module.activate()).contributions.tools ?? [];
    expect(tools.map(tool => tool.definition.name)).toEqual(['browser_test']);
    const test = tools[0]!;
    await test.runtime.prepare({ testPath: 'page.spec.ts' }, context(test));
    expect(preparedCommands[0]).toMatchObject({ argv: ['test', join(root, 'page.spec.ts')], requested: { network: true, externalWrite: true, destructive: true, credentials: false, unknownRisk: true } });
    expect(JSON.stringify(test.definition.inputSchema)).not.toMatch(/cookie|authorization|storage|endpoint/i);
  });

  it('refreshes generations without exposing the session and closes the shared Host connector only on disposal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'browser-capability-')); roots.push(root);
    let closed = 0;
    const port = browser();
    const tracked = { ...port, close: () => { closed++; return Promise.resolve(); } } satisfies BrowserSessionPort;
    const module = await createBrowserCapability(capabilityHost(root, { browser: tracked })).load();
    const first = await module.activate();
    const refreshed = await module.refresh?.(first);
    expect(refreshed).not.toBe(first);
    expect(closed).toBe(0);
    await module.dispose?.();
    expect(closed).toBe(1);
  });
});
