import { describe, expect, it } from 'vitest';
import { CdpBrowserSessionConnector, type BrowserWebSocket } from '../src/browser-connector.js';

class FakeCdpSocket implements BrowserWebSocket {
  readonly readyState = 1;
  readonly sent: Array<Record<string, unknown>> = [];
  readonly #listeners = new Map<string, Set<(event: { data?: unknown }) => void>>();
  closed = false;

  addEventListener(type: 'open' | 'message' | 'error' | 'close', listener: (event: { data?: unknown }) => void): void {
    const listeners = this.#listeners.get(type) ?? new Set(); listeners.add(listener); this.#listeners.set(type, listeners);
  }
  removeEventListener(type: 'open' | 'message' | 'error' | 'close', listener: (event: { data?: unknown }) => void): void { this.#listeners.get(type)?.delete(listener); }
  close(): void { this.closed = true; this.#emit('close', {}); }
  send(data: string): void {
    const command = JSON.parse(data) as Record<string, unknown>; this.sent.push(command);
    const method = String(command.method); const id = command.id;
    let result: unknown = {};
    if (method === 'Target.createTarget') result = { targetId: 'dedicated-target-id' };
    if (method === 'Target.attachToTarget') result = { sessionId: 'real-cdp-session-id' };
    if (method === 'Runtime.evaluate') {
      const expression = String((command.params as Record<string, unknown>).expression);
      const value = expression === 'document.readyState' ? 'complete'
        : expression.includes('maxElements') ? { url: 'https://example.test/account', title: 'Account', text: 'Signed in page', truncated: false, elements: [{ selector: '#save', role: 'button', text: 'Save', disabled: false }] }
          : expression.includes('return false') ? true
            : { url: 'https://example.test/account', title: 'Account' };
      result = { result: { value } };
    }
    if (method === 'Page.getLayoutMetrics') result = { cssContentSize: { x: 0, y: 0, width: 800, height: 1200 } };
    if (method === 'Page.captureScreenshot') result = { data: Buffer.from('png-bytes').toString('base64') };
    this.#emit('message', { data: JSON.stringify({ id, result }) });
  }
  #emit(type: string, event: { data?: unknown }): void { for (const listener of this.#listeners.get(type) ?? []) listener(event); }
}

describe('CDP browser session connector', () => {
  it('reuses a local external session through opaque refs without Cookie or Storage commands', async () => {
    const socket = new FakeCdpSocket();
    const requested: string[] = [];
    const connector = new CdpBrowserSessionConnector({
      endpoint: 'http://127.0.0.1:9222',
      fetch: input => {
        requested.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        return Promise.resolve(new Response(JSON.stringify({ Browser: 'Chrome/140', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/private-id' }), { status: 200, headers: { 'Set-Cookie': 'browser-private=value' } }));
      },
      webSocketFactory: () => socket,
    });

    await expect(connector.probe()).resolves.toEqual({ status: 'available', browser: 'Chrome/140' });
    const connected = await connector.connect();
    expect(connected.sessionRef).toMatch(/^browser-session:/);
    expect(connected.pages[0]?.pageRef).toMatch(/^browser-page:/);
    expect(JSON.stringify(connected)).not.toContain('private-id');
    expect(JSON.stringify(connected)).not.toContain('browser-private');

    const navigated = await connector.navigate(connected.pages[0]?.pageRef, 'https://example.test/account');
    await expect(connector.navigate(navigated.pageRef, 'https://user:pass@example.test/private')).resolves.toMatchObject({
      pageRef: navigated.pageRef,
    });
    const read = await connector.read(navigated.pageRef);
    await connector.click(navigated.pageRef, '#save');
    await connector.interact(navigated.pageRef, { kind: 'type', selector: '#name', value: 'Ada' });
    const screenshot = await connector.screenshot(navigated.pageRef, true);

    expect(read).toMatchObject({ text: 'Signed in page', elements: [{ selector: '#save' }] });
    expect(Buffer.from(screenshot.bytes).toString()).toBe('png-bytes');
    expect(requested).toEqual(['http://127.0.0.1:9222/json/version', 'http://127.0.0.1:9222/json/version']);
    const wire = JSON.stringify(socket.sent);
    expect(wire).not.toMatch(/cookie|set-cookie|localstorage|sessionstorage|network\.get/i);
    expect(socket.sent.map(command => command.method)).toContain('Target.attachToTarget');
    expect(socket.sent.map(command => command.method)).not.toContain('Target.getTargets');
    expect(socket.sent.map(command => command.method)).toContain('Page.captureScreenshot');
    expect(socket.sent.find(command => command.method === 'Page.navigate'
      && command.params !== null
      && typeof command.params === 'object'
      && 'url' in command.params
      && command.params.url === 'https://user:pass@example.test/private')).toBeDefined();
    await connector.close();
    expect(socket.closed).toBe(true);
    expect(socket.sent.map(command => command.method)).toContain('Target.closeTarget');
  });

  it('rejects remote or credential-bearing debugging endpoints', () => {
    expect(() => new CdpBrowserSessionConnector({ endpoint: 'http://remote.example:9222' })).toThrow('loopback');
    expect(() => new CdpBrowserSessionConnector({ endpoint: 'http://user:pass@127.0.0.1:9222' })).toThrow('unauthenticated');
  });

  it('rejects oversized screenshots before decoding them', async () => {
    const socket = new FakeCdpSocket();
    const connector = new CdpBrowserSessionConnector({ endpoint: 'ws://127.0.0.1:9222/devtools/browser/id', webSocketFactory: () => socket, maxScreenshotBytes: 4 });
    const connected = await connector.connect();
    await expect(connector.screenshot(connected.pages[0]!.pageRef, false)).rejects.toThrow('oversized screenshot');
  });

  it('honors cancellation and an elapsed Host deadline before connecting', async () => {
    const connector = new CdpBrowserSessionConnector({ endpoint: 'ws://127.0.0.1:9222/devtools/browser/id', webSocketFactory: () => new FakeCdpSocket() });
    const controller = new AbortController(); controller.abort();
    await expect(connector.probe({ signal: controller.signal })).rejects.toMatchObject({ kind: 'cancelled' });
    await expect(connector.connect({ deadline: new Date(Date.now() - 1).toISOString() })).rejects.toMatchObject({ kind: 'timeout' });
  });
});
