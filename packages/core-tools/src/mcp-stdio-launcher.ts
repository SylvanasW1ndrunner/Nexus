import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { McpServerConfig, McpEnvValue } from './mcp-config-store.js';
import type {
  McpRuntimeClient,
  McpRuntimeExitEvent,
  McpRuntimeLauncher,
} from './mcp-runtime-manager.js';
import type { McpToolSpec } from './mcp-tool-adapter.js';

export type McpSecretResolver = (ref: string) => Promise<string | undefined> | string | undefined;

export type StdioMcpLauncherOptions = {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  requestTimeoutMs?: number;
  stderrLimitBytes?: number;
  resolveSecret?: McpSecretResolver;
};

type JsonRpcResponse = {
  jsonrpc?: string;
  id?: number | string | null;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_STDERR_LIMIT_BYTES = 64 * 1024;

export function createStdioMcpRuntimeLauncher(options: StdioMcpLauncherOptions = {}): McpRuntimeLauncher {
  return async (server) => launchStdioMcpServer(server, options);
}

export async function launchStdioMcpServer(
  server: McpServerConfig,
  options: StdioMcpLauncherOptions = {},
): Promise<McpRuntimeClient> {
  if (server.transport !== 'stdio') throw new Error(`MCP server ${server.id} is not a stdio server.`);
  if (!server.command) throw new Error(`MCP stdio server ${server.id} requires a command.`);

  const child = spawn(server.command, server.args ?? [], {
    cwd: options.cwd,
    env: await resolveProcessEnv(server.env, options),
    stdio: 'pipe',
    windowsHide: true,
  });

  return new StdioMcpRuntimeClient(server.id, child, options);
}

class StdioMcpRuntimeClient implements McpRuntimeClient {
  private readonly pending = new Map<number, PendingRequest>();
  private readonly requestTimeoutMs: number;
  private readonly stderrLimitBytes: number;
  private nextId = 1;
  private initialized = false;
  private closed = false;
  private stopping = false;
  private stderrPreview = '';
  private readonly exitHandlers = new Set<(event: McpRuntimeExitEvent) => void>();

  constructor(
    private readonly serverId: string,
    private readonly child: ChildProcessWithoutNullStreams,
    options: StdioMcpLauncherOptions,
  ) {
    this.requestTimeoutMs = positiveInteger(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
    this.stderrLimitBytes = positiveInteger(options.stderrLimitBytes, DEFAULT_STDERR_LIMIT_BYTES);
    this.bindProcess();
  }

  async listTools(): Promise<McpToolSpec[]> {
    await this.ensureInitialized();
    const result = await this.request('tools/list', {});
    if (!isRecord(result) || !Array.isArray(result.tools)) {
      throw new Error(`MCP server ${this.serverId} returned an invalid tools/list result.`);
    }
    return result.tools.map(normalizeToolSpec);
  }

  async callTool(toolName: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    await this.ensureInitialized();
    if (signal.aborted) throw new Error(`MCP tool call aborted before request: ${toolName}.`);
    return this.request('tools/call', { name: toolName, arguments: args }, signal);
  }

  stop(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.stopping = true;
    this.closed = true;
    this.rejectAll(new Error(`MCP server ${this.serverId} stopped.`));
    this.child.kill();
    return Promise.resolve();
  }

  onExit(handler: (event: McpRuntimeExitEvent) => void): () => void {
    this.exitHandlers.add(handler);
    return () => {
      this.exitHandlers.delete(handler);
    };
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'DBAgent', version: '0.1.0' },
    });
    this.notify('notifications/initialized', {});
    this.initialized = true;
  }

  private request(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (this.closed || this.child.killed) throw new Error(`MCP server ${this.serverId} is not running.`);
    const id = this.nextId++;
    const payload = { jsonrpc: '2.0', id, method, params };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request ${method} timed out after ${this.requestTimeoutMs}ms.`));
      }, this.requestTimeoutMs);
      const abort = () => {
        this.pending.delete(id);
        clearTimeout(timeout);
        reject(new Error(`MCP request ${method} aborted.`));
      };
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener('abort', abort, { once: true });
      this.pending.set(id, {
        resolve: (value) => {
          signal?.removeEventListener('abort', abort);
          resolve(value);
        },
        reject: (error) => {
          signal?.removeEventListener('abort', abort);
          reject(error);
        },
        timeout,
      });
      this.child.stdin.write(`${JSON.stringify(payload)}\n`, 'utf8');
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    if (!this.closed && !this.child.killed) {
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`, 'utf8');
    }
  }

  private bindProcess(): void {
    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', (line) => this.onLine(line));
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.stderrPreview = limitTail(`${this.stderrPreview}${chunk.toString('utf8')}`, this.stderrLimitBytes);
    });
    this.child.on('error', (error) => {
      this.closed = true;
      this.rejectAll(error);
      this.emitExit({ errorMessage: error.message });
    });
    this.child.on('exit', (code, signal) => {
      this.closed = true;
      this.rejectAll(
        new Error(
          `MCP server ${this.serverId} exited with code ${code ?? 'null'} signal ${signal ?? 'null'}${this.stderrPreview ? `: ${this.stderrPreview}` : ''}`,
        ),
      );
      this.emitExit({
        ...(code === null ? {} : { code }),
        ...(signal === null ? {} : { signal }),
        ...(this.stderrPreview ? { stderrPreview: this.stderrPreview } : {}),
      });
    });
  }

  private emitExit(event: McpRuntimeExitEvent): void {
    if (this.stopping) return;
    const fullEvent = { ...event, at: new Date().toISOString() };
    for (const handler of [...this.exitHandlers]) {
      handler(fullEvent);
    }
  }

  private onLine(line: string): void {
    let message: JsonRpcResponse;
    try {
      message = JSON.parse(line) as JsonRpcResponse;
    } catch {
      return;
    }
    if (typeof message.id !== 'number') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timeout);
    if (message.error) {
      pending.reject(new Error(message.error.message ?? `MCP JSON-RPC error ${message.error.code ?? 'unknown'}.`));
      return;
    }
    pending.resolve(message.result);
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

async function resolveProcessEnv(
  env: Record<string, McpEnvValue> | undefined,
  options: StdioMcpLauncherOptions,
): Promise<NodeJS.ProcessEnv> {
  const output: NodeJS.ProcessEnv = { ...(options.env ?? process.env) };
  for (const [name, value] of Object.entries(env ?? {})) {
    if (typeof value === 'string') {
      output[name] = value;
      continue;
    }
    const resolved = await options.resolveSecret?.(value.ref);
    if (resolved === undefined) throw new Error(`Missing secret for MCP env ref ${value.ref}.`);
    output[name] = resolved;
  }
  return output;
}

function normalizeToolSpec(input: unknown): McpToolSpec {
  if (!isRecord(input) || typeof input.name !== 'string') throw new Error('Invalid MCP tool spec.');
  return {
    name: input.name,
    ...(typeof input.description === 'string' ? { description: input.description } : {}),
    ...(isRecord(input.inputSchema) ? { inputSchema: input.inputSchema } : {}),
    ...(isRecord(input.annotations) ? { annotations: input.annotations } : {}),
  };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
