import { randomUUID } from 'node:crypto';
import {
  BrowserSessionError,
  type BrowserActionResult,
  type BrowserElementSummary,
  type BrowserInteraction,
  type BrowserOperationContext,
  type BrowserPageContent,
  type BrowserPageRef,
  type BrowserPageSummary,
  type BrowserScreenshot,
  type BrowserSessionConnection,
  type BrowserSessionPort,
  type BrowserSessionProbe,
  type BrowserSessionRef,
} from './browser-session-port.js';
import { hasControlCodePoint } from './input-validation.js';

type FetchLike = typeof fetch;
type WebSocketEvent = Readonly<{ data?: unknown; message?: string }>;
export type BrowserWebSocket = Readonly<{
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open' | 'message' | 'error' | 'close', listener: (event: WebSocketEvent) => void, options?: { once?: boolean }): void;
  removeEventListener(type: 'open' | 'message' | 'error' | 'close', listener: (event: WebSocketEvent) => void): void;
}>;

export type CdpBrowserSessionConnectorOptions = Readonly<{
  /** Host-owned local endpoint; it is never included in Tool input or output. */
  endpoint: string;
  fetch?: FetchLike;
  webSocketFactory?: (url: string) => BrowserWebSocket;
  timeoutMs?: number;
  maxTextChars?: number;
  maxElements?: number;
  maxScreenshotBytes?: number;
  maxScreenshotPixels?: number;
}>;

type CdpResponse = Readonly<{ id?: number; result?: unknown; error?: Readonly<{ code?: number; message?: string }> }>;
type CdpPending = Readonly<{ resolve(value: unknown): void; reject(error: Error): void; timeout: ReturnType<typeof setTimeout> }>;
type AttachedPage = Readonly<{ pageRef: BrowserPageRef; targetId: string; sessionId: string }>;

const OPEN = 1;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TEXT_CHARS = 120_000;
const MAX_ELEMENTS = 300;
const MAX_SCREENSHOT_BYTES = 32_000_000;
const MAX_SCREENSHOT_PIXELS = 50_000_000;

/** Connects to a user-started local Chrome/Edge CDP session without reading browser credentials. */
export class CdpBrowserSessionConnector implements BrowserSessionPort {
  readonly #endpoint: URL;
  readonly #fetch: FetchLike;
  readonly #webSocketFactory: (url: string) => BrowserWebSocket;
  readonly #timeoutMs: number;
  readonly #maxTextChars: number;
  readonly #maxElements: number;
  readonly #maxScreenshotBytes: number;
  readonly #maxScreenshotPixels: number;
  #client: CdpClient | undefined;
  #sessionRef: BrowserSessionRef | undefined;
  #pages = new Map<BrowserPageRef, AttachedPage>();
  #defaultPage: BrowserPageRef | undefined;

  constructor(options: CdpBrowserSessionConnectorOptions) {
    this.#endpoint = localEndpoint(options.endpoint);
    this.#fetch = options.fetch ?? fetch;
    this.#webSocketFactory = options.webSocketFactory ?? (url => new WebSocket(url));
    this.#timeoutMs = boundedInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 500, 120_000);
    this.#maxTextChars = boundedInteger(options.maxTextChars, MAX_TEXT_CHARS, 1_000, 1_000_000);
    this.#maxElements = boundedInteger(options.maxElements, MAX_ELEMENTS, 1, 2_000);
    this.#maxScreenshotBytes = boundedInteger(options.maxScreenshotBytes, MAX_SCREENSHOT_BYTES, 1, 64_000_000);
    this.#maxScreenshotPixels = boundedInteger(options.maxScreenshotPixels, MAX_SCREENSHOT_PIXELS, 1, 100_000_000);
  }

  async probe(context?: BrowserOperationContext): Promise<BrowserSessionProbe> {
    try {
      const version = await this.#resolveVersion(context);
      return Object.freeze({ status: 'available', ...(version.browser ? { browser: version.browser } : {}) });
    } catch (error) {
      if (error instanceof BrowserSessionError && (error.kind === 'cancelled' || error.kind === 'timeout')) throw error;
      return Object.freeze({ status: 'unavailable', reason: diagnostic(error) });
    }
  }

  async connect(context?: BrowserOperationContext): Promise<BrowserSessionConnection> {
    if (this.#client && this.#sessionRef) return this.#connectionSummary(context);
    const version = await this.#resolveVersion(context);
    const socketEndpoint = version.webSocketDebuggerUrl ?? (this.#endpoint.protocol.startsWith('ws') ? this.#endpoint.toString() : undefined);
    if (!socketEndpoint) throw new BrowserSessionError('precondition', 'The local browser did not publish a DevTools websocket endpoint.');
    const client = new CdpClient(this.#webSocketFactory(localEndpoint(socketEndpoint, true).toString()), this.#timeoutMs);
    await client.open(context);
    this.#client = client;
    this.#sessionRef = opaqueRef('browser-session') as BrowserSessionRef;
    try {
      // A dedicated page shares the external browser profile's login state,
      // but never grants authority over the user's already-open tabs.
      const created = await client.request('Target.createTarget', { url: 'about:blank' }, undefined, context) as { targetId?: unknown };
      if (typeof created.targetId !== 'string') throw new BrowserSessionError('external', 'The browser did not create a page target.');
      await this.#attachTarget(created.targetId, context);
      return await this.#connectionSummary(context);
    } catch (error) {
      await this.close();
      throw browserError(error, 'Could not attach to the local browser session.');
    }
  }

  async navigate(pageRef: BrowserPageRef | undefined, url: string, context?: BrowserOperationContext): Promise<BrowserActionResult> {
    const page = this.#page(pageRef);
    const destination = navigableUrl(url);
    await this.#request('Page.navigate', { url: destination }, page, context);
    await this.#waitForReady(page, context);
    return this.#action(page, context);
  }

  async read(pageRef: BrowserPageRef, context?: BrowserOperationContext): Promise<BrowserPageContent> {
    const page = this.#page(pageRef);
    const expression = `(() => {
      const maxText = ${this.#maxTextChars}; const maxElements = ${this.#maxElements};
      const body = document.body?.innerText ?? ''; const text = body.slice(0, maxText);
      const nodes = Array.from(document.querySelectorAll('a[href],button,input,textarea,select,[role],[contenteditable="true"]')).slice(0, maxElements);
      const selector = (element) => {
        if (element.id) return '#' + CSS.escape(element.id);
        const testId = element.getAttribute('data-testid'); if (testId) return '[data-testid=' + JSON.stringify(testId) + ']';
        const name = element.getAttribute('name'); if (name) return element.tagName.toLowerCase() + '[name=' + JSON.stringify(name) + ']';
        const parts = []; let node = element;
        while (node && node.nodeType === 1 && parts.length < 5) {
          let part = node.tagName.toLowerCase(); const parent = node.parentElement;
          if (parent) { const peers = Array.from(parent.children).filter(x => x.tagName === node.tagName); if (peers.length > 1) part += ':nth-of-type(' + (peers.indexOf(node) + 1) + ')'; }
          parts.unshift(part); node = parent;
        }
        return parts.join(' > ');
      };
      return { url: location.href, title: document.title, text, truncated: body.length > maxText,
        elements: nodes.map(element => ({ selector: selector(element), role: element.getAttribute('role') || element.tagName.toLowerCase(),
          text: ((element.innerText || element.getAttribute('aria-label') || element.getAttribute('placeholder') || '') + '').trim().slice(0, 500),
          disabled: Boolean(element.disabled || element.getAttribute('aria-disabled') === 'true') })) };
    })()`;
    const value = await this.#evaluate(page, expression, context);
    if (!isRecord(value) || typeof value.url !== 'string' || typeof value.title !== 'string' || typeof value.text !== 'string' || !Array.isArray(value.elements)) {
      throw new BrowserSessionError('external', 'The browser returned an invalid page projection.');
    }
    const elements = value.elements.slice(0, this.#maxElements).map(elementSummary);
    return Object.freeze({
      sessionRef: this.#requiredSession(), pageRef: page.pageRef,
      url: value.url, title: value.title, text: value.text.slice(0, this.#maxTextChars),
      elements: Object.freeze(elements), truncated: value.truncated === true || value.text.length > this.#maxTextChars,
    });
  }

  async click(pageRef: BrowserPageRef, selector: string, context?: BrowserOperationContext): Promise<BrowserActionResult> {
    const page = this.#page(pageRef); const requested = selectorValue(selector);
    const value = await this.#evaluate(page, `(() => { const element = document.querySelector(${JSON.stringify(requested)}); if (!element) return false; element.scrollIntoView({block:'center', inline:'center'}); element.click(); return true; })()`, context);
    if (value !== true) throw new BrowserSessionError('not_found', 'No page element matched the selector.');
    await this.#settle(page, context);
    return this.#action(page, context);
  }

  async interact(pageRef: BrowserPageRef, interaction: BrowserInteraction, context?: BrowserOperationContext): Promise<BrowserActionResult> {
    const page = this.#page(pageRef); const selector = selectorValue(interaction.selector);
    const value = interaction.value === undefined ? undefined : boundedText(interaction.value, 'interaction value', 32_768);
    const script = interactionScript(interaction.kind, selector, value);
    const applied = await this.#evaluate(page, script, context);
    if (applied !== true) throw new BrowserSessionError('not_found', 'No compatible page element matched the interaction.');
    await this.#settle(page, context);
    return this.#action(page, context);
  }

  async screenshot(pageRef: BrowserPageRef, fullPage: boolean, context?: BrowserOperationContext): Promise<BrowserScreenshot> {
    const page = this.#page(pageRef);
    let params: Record<string, unknown> = { format: 'png', fromSurface: true, captureBeyondViewport: fullPage };
    if (fullPage) {
      const metrics = await this.#request('Page.getLayoutMetrics', {}, page, context) as { cssContentSize?: { x?: number; y?: number; width?: number; height?: number } };
      const size = metrics.cssContentSize;
      if (size && finite(size.width) && finite(size.height)) {
        if (size.width * size.height > this.#maxScreenshotPixels) throw new BrowserSessionError('invalid_argument', 'The full-page screenshot exceeds the configured pixel limit.');
        params = { ...params, clip: { x: finite(size.x) ? size.x : 0, y: finite(size.y) ? size.y : 0, width: size.width, height: size.height, scale: 1 } };
      }
    }
    const result = await this.#request('Page.captureScreenshot', params, page, context) as { data?: unknown };
    if (typeof result.data !== 'string' || result.data.length > Math.ceil(this.#maxScreenshotBytes / 3) * 4 + 4 || result.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(result.data)) throw new BrowserSessionError('external', 'The browser returned an invalid or oversized screenshot payload.');
    const bytes = Uint8Array.from(Buffer.from(result.data, 'base64'));
    if (bytes.byteLength > this.#maxScreenshotBytes) throw new BrowserSessionError('external', 'The browser returned an oversized screenshot payload.');
    const details = await this.#action(page, context);
    return Object.freeze({ ...details, mediaType: 'image/png', bytes });
  }

  async close(context?: BrowserOperationContext): Promise<void> {
    const client = this.#client;
    if (client) {
      for (const page of this.#pages.values()) await client.request('Target.closeTarget', { targetId: page.targetId }, undefined, context).catch(() => undefined);
      client.close();
    }
    this.#client = undefined; this.#sessionRef = undefined; this.#pages.clear(); this.#defaultPage = undefined;
  }

  async #resolveVersion(context?: BrowserOperationContext): Promise<{ browser?: string; webSocketDebuggerUrl?: string }> {
    assertContext(context);
    if (this.#endpoint.protocol.startsWith('ws')) return { webSocketDebuggerUrl: this.#endpoint.toString() };
    const endpoint = new URL('/json/version', this.#endpoint);
    let response: Response;
    try { response = await deadlinePromise(this.#fetch(endpoint, { method: 'GET', redirect: 'error', ...(context?.signal ? { signal: context.signal } : {}) }), this.#timeoutMs, context); }
    catch (error) { throw browserError(error, 'Could not reach the local browser debugging endpoint.'); }
    if (!response.ok) throw new BrowserSessionError('external', `The local browser debugging endpoint returned HTTP ${response.status}.`);
    const value: unknown = await deadlinePromise(response.json(), this.#timeoutMs, context).catch(error => { throw browserError(error, 'The local browser returned invalid version metadata.'); });
    if (!isRecord(value)) throw new BrowserSessionError('external', 'The local browser returned invalid version metadata.');
    return {
      ...(typeof value.Browser === 'string' ? { browser: value.Browser.slice(0, 256) } : {}),
      ...(typeof value.webSocketDebuggerUrl === 'string' ? { webSocketDebuggerUrl: value.webSocketDebuggerUrl } : {}),
    };
  }

  async #attachTarget(targetId: string, context?: BrowserOperationContext): Promise<void> {
    const attached = await this.#requiredClient().request('Target.attachToTarget', { targetId, flatten: true }, undefined, context) as { sessionId?: unknown };
    if (typeof attached.sessionId !== 'string') throw new BrowserSessionError('external', 'The browser did not attach to a page target.');
    const pageRef = opaqueRef('browser-page') as BrowserPageRef;
    const page = Object.freeze({ pageRef, targetId, sessionId: attached.sessionId });
    this.#pages.set(pageRef, page); this.#defaultPage ??= pageRef;
    await this.#requiredClient().request('Page.enable', {}, page.sessionId, context);
    await this.#requiredClient().request('Runtime.enable', {}, page.sessionId, context);
  }

  async #connectionSummary(context?: BrowserOperationContext): Promise<BrowserSessionConnection> {
    const pages: BrowserPageSummary[] = [];
    for (const page of this.#pages.values()) {
      const value = await this.#evaluate(page, '({url: location.href, title: document.title})', context);
      pages.push(Object.freeze({ pageRef: page.pageRef, url: isRecord(value) && typeof value.url === 'string' ? value.url : '', title: isRecord(value) && typeof value.title === 'string' ? value.title : '' }));
    }
    return Object.freeze({ sessionRef: this.#requiredSession(), pages: Object.freeze(pages) });
  }

  async #action(page: AttachedPage, context?: BrowserOperationContext): Promise<BrowserActionResult> {
    const value = await this.#evaluate(page, '({url: location.href, title: document.title})', context);
    return Object.freeze({ sessionRef: this.#requiredSession(), pageRef: page.pageRef, url: isRecord(value) && typeof value.url === 'string' ? value.url : '', title: isRecord(value) && typeof value.title === 'string' ? value.title : '' });
  }

  async #evaluate(page: AttachedPage, expression: string, context?: BrowserOperationContext): Promise<unknown> {
    const result = await this.#request('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, page, context) as { exceptionDetails?: unknown; result?: { value?: unknown } };
    if (result.exceptionDetails) throw new BrowserSessionError('external', 'The browser could not evaluate the requested page action.');
    return result.result?.value;
  }

  #request(method: string, params: Record<string, unknown>, page: AttachedPage, context?: BrowserOperationContext): Promise<unknown> {
    return this.#requiredClient().request(method, params, page.sessionId, context);
  }

  async #waitForReady(page: AttachedPage, context?: BrowserOperationContext): Promise<void> {
    const until = Math.min(Date.now() + this.#timeoutMs, contextDeadline(context));
    while (Date.now() < until) {
      if (await this.#evaluate(page, 'document.readyState', context) !== 'loading') return;
      await delay(50, context);
    }
    throw new BrowserSessionError('timeout', 'Timed out waiting for the page to become ready.');
  }

  async #settle(page: AttachedPage, context?: BrowserOperationContext): Promise<void> {
    await delay(75, context); await this.#evaluate(page, 'document.readyState', context);
  }

  #page(pageRef?: BrowserPageRef): AttachedPage {
    const selected = pageRef ?? this.#defaultPage;
    if (!selected) throw new BrowserSessionError('precondition', 'No browser page is attached.');
    const page = this.#pages.get(selected);
    if (!page) throw new BrowserSessionError('not_found', 'The browser page reference is no longer active.');
    return page;
  }

  #requiredClient(): CdpClient { if (!this.#client) throw new BrowserSessionError('precondition', 'The browser session is not connected.'); return this.#client; }
  #requiredSession(): BrowserSessionRef { if (!this.#sessionRef) throw new BrowserSessionError('precondition', 'The browser session is not connected.'); return this.#sessionRef; }
}

class CdpClient {
  #nextId = 0;
  #pending = new Map<number, CdpPending>();
  #opened = false;

  constructor(private readonly socket: BrowserWebSocket, private readonly timeoutMs: number) {
    socket.addEventListener('message', event => this.#message(event));
    socket.addEventListener('close', () => this.#failAll(new BrowserSessionError('external', 'The browser debugging connection closed.')));
    socket.addEventListener('error', () => this.#failAll(new BrowserSessionError('external', 'The browser debugging connection failed.')));
  }

  async open(context?: BrowserOperationContext): Promise<void> {
    assertContext(context);
    if (this.socket.readyState === OPEN) { this.#opened = true; return; }
    await deadlinePromise(new Promise<void>((resolve, reject) => {
      const opened = () => { cleanup(); this.#opened = true; resolve(); };
      const failed = () => { cleanup(); reject(new BrowserSessionError('external', 'Could not open the browser debugging connection.')); };
      const cleanup = () => { this.socket.removeEventListener('open', opened); this.socket.removeEventListener('error', failed); this.socket.removeEventListener('close', failed); };
      this.socket.addEventListener('open', opened, { once: true }); this.socket.addEventListener('error', failed, { once: true }); this.socket.addEventListener('close', failed, { once: true });
    }), this.timeoutMs, context);
  }

  request(method: string, params: Record<string, unknown>, sessionId?: string, context?: BrowserOperationContext): Promise<unknown> {
    assertContext(context);
    if (!this.#opened || this.socket.readyState !== OPEN) return Promise.reject(new BrowserSessionError('precondition', 'The browser debugging connection is not open.'));
    const id = ++this.#nextId;
    return deadlinePromise(new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => { this.#pending.delete(id); reject(new BrowserSessionError('timeout', `Browser command ${method} timed out.`)); }, effectiveTimeout(this.timeoutMs, context));
      this.#pending.set(id, { resolve, reject, timeout });
      try { this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
      catch (error) { clearTimeout(timeout); this.#pending.delete(id); reject(browserError(error, `Could not send browser command ${method}.`)); }
    }), this.timeoutMs, context);
  }

  close(): void { this.#opened = false; this.socket.close(); this.#failAll(new BrowserSessionError('cancelled', 'Browser session connector closed.')); }

  #message(event: WebSocketEvent): void {
    let response: CdpResponse;
    try { response = JSON.parse(String(event.data)) as CdpResponse; } catch { return; }
    if (typeof response.id !== 'number') return;
    const pending = this.#pending.get(response.id); if (!pending) return;
    clearTimeout(pending.timeout); this.#pending.delete(response.id);
    if (response.error) pending.reject(new BrowserSessionError('external', `Browser command failed${response.error.code === undefined ? '' : ` (${response.error.code})`}: ${response.error.message ?? 'unknown error'}`));
    else pending.resolve(response.result ?? {});
  }

  #failAll(error: Error): void { for (const pending of this.#pending.values()) { clearTimeout(pending.timeout); pending.reject(error); } this.#pending.clear(); }
}

function localEndpoint(raw: string, websocketOnly = false): URL {
  let value: URL;
  try { value = new URL(boundedText(raw, 'browser endpoint', 4_096)); } catch { throw new BrowserSessionError('invalid_argument', 'The browser endpoint must be a valid local URL.'); }
  const allowed = websocketOnly ? ['ws:', 'wss:'] : ['http:', 'https:', 'ws:', 'wss:'];
  if (!allowed.includes(value.protocol) || !['localhost', '127.0.0.1', '::1', '[::1]'].includes(value.hostname) || value.username || value.password) throw new BrowserSessionError('invalid_argument', 'The browser endpoint must be an unauthenticated loopback URL.');
  return value;
}
function navigableUrl(raw: string): string { let value: URL; try { value = new URL(boundedText(raw, 'url', 8_192)); } catch { throw new BrowserSessionError('invalid_argument', 'A valid absolute URL is required.'); } if (!['http:', 'https:'].includes(value.protocol)) throw new BrowserSessionError('invalid_argument', 'Only HTTP(S) URLs are supported.'); return value.toString(); }
function selectorValue(value: string): string { return boundedText(value, 'selector', 4_096); }
function boundedText(value: unknown, label: string, maximum: number): string { if (typeof value !== 'string' || !value.trim() || value.length > maximum || hasControlCodePoint(value)) throw new BrowserSessionError('invalid_argument', `${label} is invalid.`); return value; }
function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number { if (value === undefined) return fallback; if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new BrowserSessionError('invalid_argument', 'Browser connector limit is invalid.'); return value; }
function opaqueRef(prefix: string): string { return `${prefix}:${randomUUID()}`; }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value > 0; }
function elementSummary(value: unknown): BrowserElementSummary { if (!isRecord(value) || typeof value.selector !== 'string') throw new BrowserSessionError('external', 'The browser returned an invalid element projection.'); return Object.freeze({ selector: value.selector.slice(0, 4_096), ...(typeof value.role === 'string' ? { role: value.role.slice(0, 128) } : {}), ...(typeof value.text === 'string' ? { text: value.text.slice(0, 500) } : {}), ...(typeof value.disabled === 'boolean' ? { disabled: value.disabled } : {}) }); }
function diagnostic(error: unknown): string { return error instanceof Error ? error.message.slice(0, 2_000) : 'The local browser session is unavailable.'; }
function browserError(error: unknown, message: string): BrowserSessionError { if (error instanceof BrowserSessionError) return error; if (error instanceof DOMException && error.name === 'AbortError') return new BrowserSessionError('cancelled', message); return new BrowserSessionError('external', `${message}${error instanceof Error ? ` ${error.message}` : ''}`); }
function assertContext(context?: BrowserOperationContext): void { if (context?.signal?.aborted) throw new BrowserSessionError('cancelled', 'Browser operation was cancelled.'); if (Date.now() >= contextDeadline(context)) throw new BrowserSessionError('timeout', 'Browser operation deadline elapsed.'); }
function contextDeadline(context?: BrowserOperationContext): number { if (!context?.deadline) return Number.POSITIVE_INFINITY; const value = Date.parse(context.deadline); return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY; }
function effectiveTimeout(timeoutMs: number, context?: BrowserOperationContext): number { return Math.max(1, Math.min(timeoutMs, contextDeadline(context) - Date.now())); }
async function deadlinePromise<T>(promise: Promise<T>, timeoutMs: number, context?: BrowserOperationContext): Promise<T> { assertContext(context); return new Promise<T>((resolve, reject) => { const timeout = setTimeout(() => cleanup(() => reject(new BrowserSessionError('timeout', 'Browser operation timed out.'))), effectiveTimeout(timeoutMs, context)); const aborted = () => cleanup(() => reject(new BrowserSessionError('cancelled', 'Browser operation was cancelled.'))); const cleanup = (settle: () => void) => { clearTimeout(timeout); context?.signal?.removeEventListener('abort', aborted); settle(); }; context?.signal?.addEventListener('abort', aborted, { once: true }); promise.then(value => cleanup(() => resolve(value)), error => cleanup(() => reject(browserError(error, 'Browser operation failed.')))); }); }
async function delay(milliseconds: number, context?: BrowserOperationContext): Promise<void> { await deadlinePromise(new Promise(resolve => setTimeout(resolve, milliseconds)), milliseconds + 10, context); }
function interactionScript(kind: BrowserInteraction['kind'], selector: string, value?: string): string {
  const prefix = `(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element) return false; element.scrollIntoView({block:'center', inline:'center'});`;
  if (kind === 'focus') return `${prefix} element.focus(); return true; })()`;
  if (kind === 'press') return `${prefix} element.focus(); const key=${JSON.stringify(value ?? 'Enter')}; element.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true})); element.dispatchEvent(new KeyboardEvent('keyup',{key,bubbles:true})); return true; })()`;
  if (kind === 'select') return `${prefix} if (!(element instanceof HTMLSelectElement)) return false; element.value=${JSON.stringify(value ?? '')}; element.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`;
  if (kind === 'check' || kind === 'uncheck') return `${prefix} if (!(element instanceof HTMLInputElement)) return false; element.checked=${kind === 'check'}; element.dispatchEvent(new Event('input',{bubbles:true})); element.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`;
  return `${prefix} if (!('value' in element)) return false; element.focus(); element.value=${JSON.stringify(value ?? '')}; element.dispatchEvent(new Event('input',{bubbles:true})); element.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`;
}
