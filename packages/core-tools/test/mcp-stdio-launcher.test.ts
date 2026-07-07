import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { launchStdioMcpServer, type McpServerConfig } from '../src/index.js';

const tempDirs: string[] = [];
const REAL_PROCESS_REQUEST_TIMEOUT_MS = 5_000;
const REAL_PROCESS_TEST_TIMEOUT_MS = 10_000;

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('stdio MCP launcher', () => {
  it('starts a real stdio process, lists tools, calls tools, resolves secret env refs and stops cleanly', async () => {
    const script = await fixtureServer();
    const client = await launchStdioMcpServer(
      {
        ...serverConfig(script),
        env: {
          PUBLIC_MODE: 'test',
          API_TOKEN: { ref: 'mcp:fixture:env:API_TOKEN' },
        },
      },
      {
        requestTimeoutMs: REAL_PROCESS_REQUEST_TIMEOUT_MS,
        resolveSecret: (ref) => (ref === 'mcp:fixture:env:API_TOKEN' ? 'token-from-keychain' : undefined),
      },
    );

    await expect(client.listTools()).resolves.toMatchObject([
      {
        name: 'echo',
        description: 'Echo a value',
        inputSchema: { type: 'object' },
        annotations: { readOnlyHint: true },
      },
    ]);
    await expect(client.callTool('echo', { value: 'hello' }, new AbortController().signal)).resolves.toMatchObject({
      content: [{ type: 'text', text: 'hello' }],
      env: { publicMode: 'test', hasToken: true },
    });

    await expect(client.stop()).resolves.toBeUndefined();
  }, REAL_PROCESS_TEST_TIMEOUT_MS);

  it('fails fast when a secret ref cannot be resolved', async () => {
    const script = await fixtureServer();

    await expect(
      launchStdioMcpServer(
        {
          ...serverConfig(script),
          env: { API_TOKEN: { ref: 'missing' } },
        },
        { resolveSecret: () => undefined },
      ),
    ).rejects.toThrow('Missing secret for MCP env ref missing');
  });

  it('times out requests to a stuck stdio process', async () => {
    const script = await stuckServer();
    const client = await launchStdioMcpServer(serverConfig(script), { requestTimeoutMs: 10 });

    await expect(client.listTools()).rejects.toThrow('timed out');
    await client.stop();
  });

  it('surfaces process exit and bounded stderr for startup failures after spawn', async () => {
    const script = await crashServer();
    const client = await launchStdioMcpServer(serverConfig(script), {
      requestTimeoutMs: REAL_PROCESS_REQUEST_TIMEOUT_MS,
      stderrLimitBytes: 64,
    });

    await expect(client.listTools()).rejects.toThrow(/exited with code 7/);
  }, REAL_PROCESS_TEST_TIMEOUT_MS);
});

function serverConfig(script: string): McpServerConfig {
  return {
    id: 'fixture',
    name: 'Fixture',
    source: 'user',
    transport: 'stdio',
    command: process.execPath,
    args: [script],
    autoStart: false,
    enabled: true,
    installedAt: '2026-06-18T10:00:00.000Z',
    updatedAt: '2026-06-18T10:00:00.000Z',
  };
}

async function fixtureServer(): Promise<string> {
  return writeScript(`
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
function send(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n'); }
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') send(msg.id, { protocolVersion: '2024-11-05', capabilities: {} });
  if (msg.method === 'tools/list') send(msg.id, { tools: [{ name: 'echo', description: 'Echo a value', inputSchema: { type: 'object', properties: { value: { type: 'string' } } }, annotations: { readOnlyHint: true } }] });
  if (msg.method === 'tools/call') send(msg.id, { content: [{ type: 'text', text: String(msg.params.arguments.value) }], env: { publicMode: process.env.PUBLIC_MODE, hasToken: process.env.API_TOKEN === 'token-from-keychain' } });
});
`);
}

async function stuckServer(): Promise<string> {
  return writeScript(`
setInterval(() => {}, 1000);
`);
}

async function crashServer(): Promise<string> {
  return writeScript(`
process.stderr.write('x'.repeat(1000));
setTimeout(() => process.exit(7), 10);
`);
}

async function writeScript(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dbagent-mcp-stdio-'));
  tempDirs.push(dir);
  const path = join(dir, 'server.cjs');
  await writeFile(path, source, 'utf8');
  return path;
}
