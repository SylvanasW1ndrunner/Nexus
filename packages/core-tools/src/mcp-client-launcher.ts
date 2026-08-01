import type { Readable } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
  FetchLike,
  Transport,
  TransportSendOptions,
} from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolResultSchema,
  ErrorCode,
  type JSONRPCMessage,
  type MessageExtraInfo,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import type { McpEnvValue, McpHeaderValue, McpServerConfig } from './mcp-config-store.js';
import { McpToolAbortedError, McpToolTimeoutError } from './mcp-health.js';
import type {
  McpGetPromptResult,
  McpListChangedEvent,
  McpPromptSpec,
  McpReadResourceResult,
  McpResourceSpec,
  McpResourceTemplateSpec,
  McpRuntimeClient,
  McpRuntimeExitEvent,
  McpRuntimeLauncher,
  McpServerDescriptor,
} from './mcp-runtime-manager.js';
import { normalizeMcpToolSpec, type McpToolSpec } from './mcp-tool-adapter.js';

export type McpSecretResolver = (ref: string) => Promise<string | undefined> | string | undefined;

export type McpClientLauncherOptions = {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  stderrLimitBytes?: number;
  maxMessageBytes?: number;
  maxResultBytes?: number;
  paginationPageLimit?: number;
  resolveSecret?: McpSecretResolver;
  createAuthProvider?: (
    server: McpServerConfig,
  ) => Promise<OAuthClientProvider | undefined> | OAuthClientProvider | undefined;
  fetch?: typeof globalThis.fetch;
  legacySseFallback?: boolean;
  clientInfo?: {
    name: string;
    version: string;
  };
};

export type StdioMcpLauncherOptions = McpClientLauncherOptions;

type PrimitiveKind = 'tools' | 'resources' | 'prompts';
type StderrState = { preview: string; limitBytes: number };
type TransportDelegate = {
  start(): Promise<void>;
  send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void>;
  close(): Promise<void>;
  onclose?: (() => void) | undefined;
  onerror?: ((error: Error) => void) | undefined;
  onmessage?:
    | (<T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void)
    | undefined;
  sessionId?: string | undefined;
  setProtocolVersion?: ((version: string) => void) | undefined;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_STDERR_LIMIT_BYTES = 64 * 1024;
const DEFAULT_MAX_MESSAGE_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_RESULT_BYTES = 10 * 1024 * 1024;
const DEFAULT_PAGINATION_PAGE_LIMIT = 1_000;
const DEFAULT_CLIENT_INFO = { name: 'SchemaNaut', version: '0.1.0-alpha.1' };

export class McpResultTooLargeError extends Error {
  constructor(
    readonly serverId: string,
    readonly actualBytes: number,
    readonly maxBytes: number,
  ) {
    super(
      `MCP server ${serverId} returned ${actualBytes} bytes, exceeding the ${maxBytes}-byte result limit.`,
    );
    this.name = 'McpResultTooLargeError';
  }
}

export function createMcpRuntimeLauncher(
  options: McpClientLauncherOptions = {},
): McpRuntimeLauncher {
  return async (server) => launchMcpServer(server, options);
}

export function createStdioMcpRuntimeLauncher(
  options: StdioMcpLauncherOptions = {},
): McpRuntimeLauncher {
  return async (server) => launchStdioMcpServer(server, options);
}

export async function launchMcpServer(
  server: McpServerConfig,
  options: McpClientLauncherOptions = {},
): Promise<McpRuntimeClient> {
  switch (server.transport) {
    case 'stdio':
      return launchStdioMcpServer(server, options);
    case 'sse':
      return launchRemoteMcpServer(server, 'sse', options);
    case 'streamable-http':
      try {
        return await launchRemoteMcpServer(server, 'streamable-http', options);
      } catch (streamableError) {
        if (options.legacySseFallback === false) throw streamableError;
        try {
          return await launchRemoteMcpServer(server, 'sse', options);
        } catch (sseError) {
          throw new AggregateError(
            [streamableError, sseError],
            `MCP server ${server.id} failed over Streamable HTTP (${errorMessage(streamableError)}) and legacy SSE (${errorMessage(sseError)}).`,
          );
        }
      }
  }
}

export async function launchStdioMcpServer(
  server: McpServerConfig,
  options: StdioMcpLauncherOptions = {},
): Promise<McpRuntimeClient> {
  if (server.transport !== 'stdio') {
    throw new Error(`MCP server ${server.id} is not a stdio server.`);
  }
  if (!server.command) throw new Error(`MCP stdio server ${server.id} requires a command.`);

  const stderrState: StderrState = {
    preview: '',
    limitBytes: positiveInteger(options.stderrLimitBytes, DEFAULT_STDERR_LIMIT_BYTES),
  };
  const cwd = server.cwd ?? options.cwd;
  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args ?? [],
    ...(cwd === undefined ? {} : { cwd }),
    env: await resolveProcessEnv(server.env, options),
    stderr: 'pipe',
  });
  captureStderr(transport.stderr as Readable | null, stderrState);
  return connectClient(server, 'stdio', transport, stderrState, options);
}

export async function launchRemoteMcpServer(
  server: McpServerConfig,
  transportKind: 'streamable-http' | 'sse',
  options: McpClientLauncherOptions = {},
): Promise<McpRuntimeClient> {
  if (!server.url) throw new Error(`MCP remote server ${server.id} requires a URL.`);
  const url = new URL(server.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`MCP server ${server.id} URL must use http or https.`);
  }

  const headers = await resolveRemoteHeaders(server.headers, options);
  const authProvider = await options.createAuthProvider?.(server);
  const requestInit = Object.keys(headers).length === 0 ? undefined : { headers };
  const fetchWithHeaders = createFetchWithHeaders(headers, options.fetch);

  if (transportKind === 'streamable-http') {
    const transport = new StreamableHTTPClientTransport(url, {
      ...(authProvider === undefined ? {} : { authProvider }),
      ...(requestInit === undefined ? {} : { requestInit }),
      ...(fetchWithHeaders === undefined ? {} : { fetch: fetchWithHeaders }),
    });
    return connectClient(server, transportKind, transport, undefined, options);
  }

  const transport = new SSEClientTransport(url, {
    ...(authProvider === undefined ? {} : { authProvider }),
    ...(requestInit === undefined ? {} : { requestInit }),
    ...(fetchWithHeaders === undefined
      ? {}
      : {
          fetch: fetchWithHeaders,
          eventSourceInit: { fetch: fetchWithHeaders },
        }),
  });
  return connectClient(server, transportKind, transport, undefined, options);
}

async function connectClient(
  server: McpServerConfig,
  transportKind: McpServerDescriptor['transport'],
  transport: TransportDelegate,
  stderrState: StderrState | undefined,
  options: McpClientLauncherOptions,
): Promise<McpRuntimeClient> {
  const holder: { runtime?: SdkMcpRuntimeClient } = {};
  const notify = (kind: PrimitiveKind) => holder.runtime?.queueListChanged(kind);
  const client = new Client(options.clientInfo ?? DEFAULT_CLIENT_INFO, {
    capabilities: {},
    enforceStrictCapabilities: true,
    listChanged: {
      tools: {
        autoRefresh: false,
        onChanged: () => notify('tools'),
      },
      resources: {
        autoRefresh: false,
        onChanged: () => notify('resources'),
      },
      prompts: {
        autoRefresh: false,
        onChanged: () => notify('prompts'),
      },
    },
  });

  const runtime = new SdkMcpRuntimeClient({
    serverId: server.id,
    transportKind,
    client,
    requestTimeoutMs: positiveInteger(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS),
    maxResultBytes: positiveInteger(options.maxResultBytes, DEFAULT_MAX_RESULT_BYTES),
    paginationPageLimit: positiveInteger(
      options.paginationPageLimit,
      DEFAULT_PAGINATION_PAGE_LIMIT,
    ),
    ...(stderrState === undefined ? {} : { stderrState }),
  });
  holder.runtime = runtime;
  runtime.bindLifecycle();

  try {
    await client.connect(
      new SizeLimitedTransport(
        transport,
        server.id,
        positiveInteger(options.maxMessageBytes, DEFAULT_MAX_MESSAGE_BYTES),
      ),
      {
        timeout: positiveInteger(
          options.connectTimeoutMs,
          positiveInteger(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS),
        ),
      },
    );
    runtime.markConnected();
    return runtime;
  } catch (error) {
    await runtime.closeAfterFailedConnect();
    throw error;
  }
}

class SdkMcpRuntimeClient implements McpRuntimeClient {
  private readonly exitHandlers = new Set<(event: McpRuntimeExitEvent) => void>();
  private readonly toolChangeHandlers = new Set<
    (event: McpListChangedEvent<McpToolSpec>) => void
  >();
  private readonly resourceChangeHandlers = new Set<
    (event: McpListChangedEvent<McpResourceSpec>) => void
  >();
  private readonly promptChangeHandlers = new Set<
    (event: McpListChangedEvent<McpPromptSpec>) => void
  >();
  private readonly refreshChains: Record<PrimitiveKind, Promise<void>> = {
    tools: Promise.resolve(),
    resources: Promise.resolve(),
    prompts: Promise.resolve(),
  };
  private connected = false;
  private closed = false;
  private stopping = false;
  private lastError: Error | undefined;

  constructor(
    private readonly options: {
      serverId: string;
      transportKind: McpServerDescriptor['transport'];
      client: Client;
      requestTimeoutMs: number;
      maxResultBytes: number;
      paginationPageLimit: number;
      stderrState?: StderrState;
    },
  ) {}

  bindLifecycle(): void {
    this.options.client.onerror = (error) => {
      this.lastError = error;
    };
    this.options.client.onclose = () => {
      if (this.closed) return;
      this.closed = true;
      if (this.stopping || !this.connected) return;
      const event: McpRuntimeExitEvent = {
        at: new Date().toISOString(),
        ...(this.lastError === undefined ? {} : { errorMessage: this.lastError.message }),
        ...(this.options.stderrState?.preview
          ? { stderrPreview: this.options.stderrState.preview }
          : {}),
      };
      for (const handler of [...this.exitHandlers]) handler(event);
    };
  }

  markConnected(): void {
    this.connected = true;
  }

  async closeAfterFailedConnect(): Promise<void> {
    this.stopping = true;
    this.closed = true;
    try {
      await this.options.client.close();
    } catch {
      // Initialization already failed; closing is best effort.
    }
  }

  describe(): McpServerDescriptor {
    const serverVersion = this.options.client.getServerVersion();
    const instructions = this.options.client.getInstructions();
    return {
      serverId: this.options.serverId,
      transport: this.options.transportKind,
      capabilities: cloneRecord(this.options.client.getServerCapabilities() ?? {}),
      ...(serverVersion === undefined ? {} : { serverInfo: cloneRecord(serverVersion) }),
      ...(instructions === undefined ? {} : { instructions }),
    };
  }

  async ping(signal?: AbortSignal): Promise<void> {
    await this.options.client.ping(this.requestOptions(signal));
  }

  async listTools(signal?: AbortSignal): Promise<McpToolSpec[]> {
    if (!this.options.client.getServerCapabilities()?.tools) return [];
    return this.paginate('tools', async (cursor) => {
      const result = await this.options.client.listTools(
        cursor === undefined ? undefined : { cursor },
        this.requestOptions(signal),
      );
      this.assertResultSize(result);
      return {
        items: result.tools.map((tool) => normalizeMcpToolSpec(tool)),
        ...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }),
      };
    });
  }

  async callTool(
    toolName: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (!this.options.client.getServerCapabilities()?.tools) {
      throw new Error(`MCP server ${this.options.serverId} does not support tools.`);
    }
    try {
      const result = await this.options.client.callTool(
        { name: toolName, arguments: args },
        CallToolResultSchema,
        this.requestOptions(signal),
      );
      this.assertResultSize(result);
      return result;
    } catch (error) {
      if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
        throw new McpToolAbortedError();
      }
      if (error instanceof McpError && Number(error.code) === Number(ErrorCode.RequestTimeout)) {
        throw new McpToolTimeoutError(this.options.requestTimeoutMs);
      }
      throw error;
    }
  }

  async listResources(signal?: AbortSignal): Promise<McpResourceSpec[]> {
    if (!this.options.client.getServerCapabilities()?.resources) return [];
    return this.paginate('resources', async (cursor) => {
      const result = await this.options.client.listResources(
        cursor === undefined ? undefined : { cursor },
        this.requestOptions(signal),
      );
      this.assertResultSize(result);
      return {
        items: result.resources.map(normalizeResource),
        ...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }),
      };
    });
  }

  async listResourceTemplates(signal?: AbortSignal): Promise<McpResourceTemplateSpec[]> {
    if (!this.options.client.getServerCapabilities()?.resources) return [];
    return this.paginate('resource templates', async (cursor) => {
      const result = await this.options.client.listResourceTemplates(
        cursor === undefined ? undefined : { cursor },
        this.requestOptions(signal),
      );
      this.assertResultSize(result);
      return {
        items: result.resourceTemplates.map(normalizeResourceTemplate),
        ...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }),
      };
    });
  }

  async readResource(uri: string, signal?: AbortSignal): Promise<McpReadResourceResult> {
    if (!this.options.client.getServerCapabilities()?.resources) {
      throw new Error(`MCP server ${this.options.serverId} does not support resources.`);
    }
    const result = await this.options.client.readResource({ uri }, this.requestOptions(signal));
    this.assertResultSize(result);
    const clone = cloneRecord(result);
    if (!Array.isArray(clone.contents)) {
      throw new Error(`MCP server ${this.options.serverId} returned invalid resource contents.`);
    }
    return clone as McpReadResourceResult;
  }

  async listPrompts(signal?: AbortSignal): Promise<McpPromptSpec[]> {
    if (!this.options.client.getServerCapabilities()?.prompts) return [];
    return this.paginate('prompts', async (cursor) => {
      const result = await this.options.client.listPrompts(
        cursor === undefined ? undefined : { cursor },
        this.requestOptions(signal),
      );
      this.assertResultSize(result);
      return {
        items: result.prompts.map(normalizePrompt),
        ...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }),
      };
    });
  }

  async getPrompt(
    name: string,
    args?: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<McpGetPromptResult> {
    if (!this.options.client.getServerCapabilities()?.prompts) {
      throw new Error(`MCP server ${this.options.serverId} does not support prompts.`);
    }
    const result = await this.options.client.getPrompt(
      { name, ...(args === undefined ? {} : { arguments: args }) },
      this.requestOptions(signal),
    );
    this.assertResultSize(result);
    const clone = cloneRecord(result);
    if (!Array.isArray(clone.messages)) {
      throw new Error(`MCP server ${this.options.serverId} returned invalid prompt messages.`);
    }
    return clone as McpGetPromptResult;
  }

  async stop(): Promise<void> {
    if (this.closed) return;
    this.stopping = true;
    this.closed = true;
    await this.options.client.close();
  }

  onExit(handler: (event: McpRuntimeExitEvent) => void): () => void {
    this.exitHandlers.add(handler);
    return () => this.exitHandlers.delete(handler);
  }

  onToolsChanged(handler: (event: McpListChangedEvent<McpToolSpec>) => void): () => void {
    this.toolChangeHandlers.add(handler);
    return () => this.toolChangeHandlers.delete(handler);
  }

  onResourcesChanged(handler: (event: McpListChangedEvent<McpResourceSpec>) => void): () => void {
    this.resourceChangeHandlers.add(handler);
    return () => this.resourceChangeHandlers.delete(handler);
  }

  onPromptsChanged(handler: (event: McpListChangedEvent<McpPromptSpec>) => void): () => void {
    this.promptChangeHandlers.add(handler);
    return () => this.promptChangeHandlers.delete(handler);
  }

  queueListChanged(kind: PrimitiveKind): void {
    this.refreshChains[kind] = this.refreshChains[kind]
      .catch(() => {})
      .then(() => this.refreshAndEmit(kind));
  }

  private async refreshAndEmit(kind: PrimitiveKind): Promise<void> {
    if (this.closed) return;
    try {
      if (kind === 'tools') {
        const items = await this.listTools();
        for (const handler of [...this.toolChangeHandlers]) handler({ items });
        return;
      }
      if (kind === 'resources') {
        const items = await this.listResources();
        for (const handler of [...this.resourceChangeHandlers]) handler({ items });
        return;
      }
      const items = await this.listPrompts();
      for (const handler of [...this.promptChangeHandlers]) handler({ items });
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      if (kind === 'tools') {
        for (const handler of [...this.toolChangeHandlers]) handler({ error: normalized });
      } else if (kind === 'resources') {
        for (const handler of [...this.resourceChangeHandlers]) handler({ error: normalized });
      } else {
        for (const handler of [...this.promptChangeHandlers]) handler({ error: normalized });
      }
    }
  }

  private async paginate<T>(
    label: string,
    fetchPage: (cursor: string | undefined) => Promise<{ items: T[]; nextCursor?: string }>,
  ): Promise<T[]> {
    const output: T[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;

    for (let page = 0; page < this.options.paginationPageLimit; page += 1) {
      const result = await fetchPage(cursor);
      output.push(...result.items);
      this.assertResultSize(output);
      const nextCursor = result.nextCursor;
      if (nextCursor === undefined) return output;
      if (!nextCursor || seenCursors.has(nextCursor)) {
        throw new Error(
          `MCP server ${this.options.serverId} returned a repeated ${label} pagination cursor.`,
        );
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }

    throw new Error(
      `MCP server ${this.options.serverId} exceeded the ${label} pagination page limit (${this.options.paginationPageLimit}).`,
    );
  }

  private requestOptions(signal?: AbortSignal): {
    timeout: number;
    maxTotalTimeout: number;
    signal?: AbortSignal;
  } {
    return {
      timeout: this.options.requestTimeoutMs,
      maxTotalTimeout: this.options.requestTimeoutMs,
      ...(signal === undefined ? {} : { signal }),
    };
  }

  private assertResultSize(result: unknown): void {
    const serialized = JSON.stringify(result);
    if (serialized === undefined) {
      throw new Error(`MCP server ${this.options.serverId} returned a non-JSON result.`);
    }
    const actualBytes = Buffer.byteLength(serialized, 'utf8');
    if (actualBytes > this.options.maxResultBytes) {
      throw new McpResultTooLargeError(
        this.options.serverId,
        actualBytes,
        this.options.maxResultBytes,
      );
    }
  }
}

async function resolveProcessEnv(
  env: Record<string, McpEnvValue> | undefined,
  options: McpClientLauncherOptions,
): Promise<Record<string, string>> {
  const output: Record<string, string> = options.env
    ? definedEnvironment(options.env)
    : getDefaultEnvironment();
  for (const [name, value] of Object.entries(env ?? {})) {
    output[name] = await resolveConfigValue(value, options, `MCP env ${name}`);
  }
  return output;
}

async function resolveRemoteHeaders(
  headers: Record<string, McpHeaderValue> | undefined,
  options: McpClientLauncherOptions,
): Promise<Record<string, string>> {
  const output: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    output[name] = await resolveConfigValue(value, options, `MCP header ${name}`);
  }
  return output;
}

async function resolveConfigValue(
  value: McpEnvValue,
  options: McpClientLauncherOptions,
  label: string,
): Promise<string> {
  if (typeof value === 'string') return value;
  const resolved = await options.resolveSecret?.(value.ref);
  if (resolved === undefined) throw new Error(`Missing secret for ${label} ref ${value.ref}.`);
  return resolved;
}

function definedEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function createFetchWithHeaders(
  headers: Record<string, string>,
  fetchImplementation: typeof globalThis.fetch | undefined,
): FetchLike | undefined {
  if (Object.keys(headers).length === 0 && fetchImplementation === undefined) return undefined;
  const fetcher = fetchImplementation ?? globalThis.fetch;
  return async (input, init) => {
    const merged = new Headers(init?.headers);
    for (const [name, value] of Object.entries(headers)) {
      if (!merged.has(name)) merged.set(name, value);
    }
    return fetcher(input, { ...init, headers: merged });
  };
}

/**
 * Keeps all protocol framing and parsing inside the official SDK while applying
 * a deterministic size ceiling to the JSON-RPC values crossing the transport.
 */
class SizeLimitedTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;

  constructor(
    private readonly delegate: TransportDelegate,
    private readonly serverId: string,
    private readonly maxBytes: number,
  ) {}

  async start(): Promise<void> {
    this.delegate.onclose = () => this.onclose?.();
    this.delegate.onerror = (error) => this.onerror?.(error);
    this.delegate.onmessage = (message, extra) => {
      try {
        this.assertSize(message);
        this.onmessage?.(message, extra);
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        this.onerror?.(normalized);
        void this.close();
      }
    };
    await this.delegate.start();
  }

  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    this.assertSize(message);
    await this.delegate.send(message, options);
  }

  async close(): Promise<void> {
    await this.delegate.close();
  }

  setProtocolVersion(version: string): void {
    this.delegate.setProtocolVersion?.(version);
  }

  private assertSize(message: JSONRPCMessage): void {
    const serialized = JSON.stringify(message);
    const actualBytes = Buffer.byteLength(serialized, 'utf8');
    if (actualBytes > this.maxBytes) {
      throw new Error(
        `MCP server ${this.serverId} protocol message is ${actualBytes} bytes, exceeding the ${this.maxBytes}-byte message limit.`,
      );
    }
  }
}

function captureStderr(stream: Readable | null, state: StderrState): void {
  stream?.on('data', (chunk: Buffer | string) => {
    state.preview = limitTail(`${state.preview}${chunk.toString()}`, state.limitBytes);
  });
}

function normalizeResource(input: unknown): McpResourceSpec {
  const clone = cloneRecord(input);
  if (typeof clone.uri !== 'string' || typeof clone.name !== 'string') {
    throw new Error('Invalid MCP resource spec.');
  }
  return clone as McpResourceSpec;
}

function normalizeResourceTemplate(input: unknown): McpResourceTemplateSpec {
  const clone = cloneRecord(input);
  if (typeof clone.uriTemplate !== 'string' || typeof clone.name !== 'string') {
    throw new Error('Invalid MCP resource template spec.');
  }
  return clone as McpResourceTemplateSpec;
}

function normalizePrompt(input: unknown): McpPromptSpec {
  const clone = cloneRecord(input);
  if (typeof clone.name !== 'string') throw new Error('Invalid MCP prompt spec.');
  return clone as McpPromptSpec;
}

function cloneRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('MCP protocol value must be an object.');
  }
  return JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
}

function limitTail(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.byteLength <= maxBytes) return value;
  return buffer.subarray(buffer.byteLength - maxBytes).toString('utf8');
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
