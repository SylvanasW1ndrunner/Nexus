import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentRuntime, GlobalConfigStore } from '@dbagent/agent-host';
import { startInteractiveCli } from '../src/interactive-cli.js';

const temporaryDirectories: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.SCHEMANAUT_CLI_TEST_API_KEY;
  await Promise.all(servers.splice(0).map(closeServer));
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, {
      recursive: true, force: true, maxRetries: 5, retryDelay: 20,
    })),
  );
});

describe('SchemaNaut CLI user workflows', () => {
  it('discovers global endpoints, requires explicit Session selection, and never rewrites project MCP settings', async () => {
    const facadeStart = vi.spyOn(AgentRuntime.prototype, 'startAgentRun');
    const requests: Array<Record<string, unknown>> = [];
    const endpoint = await startOpenAiFixture(requests);
    const projectDirectory = await mkdtemp(join(tmpdir(), 'schemanaut-cli-workflow-'));
    temporaryDirectories.push(projectDirectory);
    await writeCliGlobalConfig(projectDirectory, endpoint);
    const settingsPath = join(projectDirectory, '.schemanaut', 'settings.json');
    await mkdir(join(projectDirectory, '.schemanaut'), { recursive: true });
    const settingsText = `${JSON.stringify({
      version: 1,
      mcp: { servers: {} },
    }, null, 2)}\n`;
    await writeFile(settingsPath, settingsText, 'utf8');

    const first = cliHarness(projectDirectory);
    await first.waitForPrompt(1);
    expect(first.text()).toContain('发现 2 个生成模型，尚未选择');
    expect(first.text()).not.toContain('fixture-secret');
    first.send('Reply before choosing a model.');
    await first.waitForPrompt(2);
    expect(first.text()).toContain('尚未选择模型');
    first.send('/model 2');
    await first.waitForPrompt(3);
    first.send('/settings show');
    await first.waitForPrompt(4);
    expect(first.text()).toContain('项目 MCP 设置文件');
    expect(first.text()).toContain('模型连接和默认参数仅来自全局 config.toml');
    expect(first.text()).not.toContain('模型连接: 1');
    expect(first.text()).not.toContain('fixture-secret');
    first.send('/config show');
    await first.waitForPrompt(5);
    expect(first.text()).toContain('全局配置文件:');
    expect(first.text()).toContain('模型连接: 1');
    expect(first.text()).not.toContain('fixture-secret');
    first.send('Reply with the fixture answer.');
    await first.waitForPrompt(6);

    expect(first.text()).toContain('CLI fixture answer from beta-model');
    expect(facadeStart).toHaveBeenCalledTimes(1);
    const sessionId = /Session ([0-9a-f-]{36})/.exec(first.text())?.[1];
    expect(sessionId).toBeTruthy();
    first.send('/new');
    await first.waitForPrompt(7);
    first.send('This must require another explicit model selection.');
    await first.waitForPrompt(8);
    expect(first.text()).toContain('新会话尚未选择模型');
    first.send('/exit');
    await first.done;

    expect(await readFile(settingsPath, 'utf8')).toBe(settingsText);

    const firstChat = requests.find((request) => request.model === 'beta-model');
    expect(firstChat).toMatchObject({ model: 'beta-model', temperature: 0.35, top_p: 0.8 });

    const second = cliHarness(projectDirectory);
    await second.waitForPrompt(1);
    second.send(`/resume ${sessionId}`);
    await second.waitForPrompt(2);
    second.send('/model current');
    await second.waitForPrompt(3);
    expect(second.text()).toContain('beta-model');
    second.send('Continue the same Session.');
    await second.waitForPrompt(4);
    second.send('/exit');
    await second.done;

    expect(second.text()).toContain('CLI fixture answer from beta-model');
    const resumedChat = requests.filter((request) => request.model === 'beta-model').at(-1);
    expect(resumedChat).toMatchObject({ model: 'beta-model', temperature: 0.35, top_p: 0.8 });
    expect(await readFile(settingsPath, 'utf8')).toBe(settingsText);
  }, 15_000);

  it('restores the persisted Session model after resuming a Run', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const endpoint = await startOpenAiFixture(requests, { failChatCount: 2 });
    const projectDirectory = await mkdtemp(join(tmpdir(), 'schemanaut-cli-run-resume-'));
    temporaryDirectories.push(projectDirectory);
    await writeCliSettings(projectDirectory);
    await writeCliGlobalConfig(projectDirectory, endpoint);

    const first = cliHarness(projectDirectory);
    await first.waitForPrompt(1);
    first.send('/model 2');
    await first.waitForPrompt(2);
    first.send('Create a Run that can be resumed.');
    await first.waitForPrompt(3);
    const runId = /Run (run_[a-z0-9_-]+)/i.exec(first.text())?.[1];
    const sessionId = /Session ([0-9a-f-]{36})/.exec(first.text())?.[1];
    expect(runId).toBeTruthy();
    expect(sessionId).toBeTruthy();
    first.send('/exit');
    await first.done;

    const second = cliHarness(projectDirectory);
    await second.waitForPrompt(1);
    second.send(`/run resume ${runId}`);
    await second.waitForPrompt(2);
    second.send('/model current');
    await second.waitForPrompt(3);
    second.send('Continue the resumed Session.');
    await second.waitForPrompt(4);
    second.send('/exit');
    await second.done;

    expect(second.text()).toContain('模型: beta-model · Endpoint: Local Fixture');
    expect(second.text()).not.toContain('当前 Session尚未选择模型。');
    expect(second.text()).toContain(`Run ${runId} · Session ${sessionId}`);
    expect(second.text()).toContain(`Session ${sessionId}`);
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.model === 'beta-model')).toBe(true);
  }, 15_000);
});

async function writeCliSettings(projectDirectory: string): Promise<void> {
  await mkdir(join(projectDirectory, '.schemanaut'), { recursive: true });
  await writeFile(
    join(projectDirectory, '.schemanaut', 'settings.json'),
    `${JSON.stringify({
      version: 1,
      mcp: { servers: {} },
    }, null, 2)}\n`,
    'utf8',
  );
}

async function writeCliGlobalConfig(projectDirectory: string, endpoint: string): Promise<void> {
  const configDirectory = join(projectDirectory, '.test-global-config');
  const configPath = join(configDirectory, 'config.toml');
  await mkdir(configDirectory, { recursive: true });
  process.env.SCHEMANAUT_CLI_TEST_API_KEY = 'fixture-secret';
  await writeFile(configPath, [
    'version = 1',
    '',
    '[agent]',
    'permission_mode = "default"',
    '',
    '[[models.connections]]',
    'name = "Local Fixture"',
    `endpoint = "${endpoint}/v1"`,
    'api_key_env = "SCHEMANAUT_CLI_TEST_API_KEY"',
    '',
    '[models.parameters]',
    'temperature = 0.35',
    'topP = 0.8',
  ].join('\n'), 'utf8');
  vi.spyOn(GlobalConfigStore, 'defaultPath').mockReturnValue(configPath);
}

function cliHarness(projectDirectory: string): {
  done: Promise<void>;
  send(line: string): void;
  text(): string;
  waitForPrompt(count: number): Promise<void>;
} {
  const input = new PassThrough();
  const chunks: string[] = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  const text = () => chunks.join('');
  return {
    done: startInteractiveCli({ projectDirectory, input, output }),
    send: (line) => input.write(`${line}\n`),
    text,
    waitForPrompt: async (count) => {
      await vi.waitFor(
        () => expect(occurrences(text(), 'schemanaut> ')).toBeGreaterThanOrEqual(count),
        { timeout: 10_000, interval: 20 },
      );
    },
  };
}

async function startOpenAiFixture(
  requests: Array<Record<string, unknown>>,
  options: { failChatCount?: number } = {},
): Promise<string> {
  const server = createServer((request, response) => {
    void handleOpenAiFixtureRequest(request, response, requests, options).catch((error: unknown) => {
      if (!response.headersSent) {
        sendJson(response, 500, { error: { message: 'fixture request failed' } });
        return;
      }
      response.destroy(error instanceof Error ? error : undefined);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function handleOpenAiFixtureRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requests: Array<Record<string, unknown>>,
  options: { failChatCount?: number },
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://fixture.local');
  if (request.method === 'GET' && url.pathname === '/v1/models') {
    sendJson(response, 200, {
      data: [
        {
          id: 'alpha-model',
          context_window: 65_536,
          max_output_tokens: 4_096,
          supported_parameters: ['temperature', 'top_p', 'max_tokens'],
        },
        {
          id: 'beta-model',
          context_window: 131_072,
          max_output_tokens: 8_192,
          supported_parameters: ['temperature', 'top_p', 'max_tokens'],
        },
      ],
    });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
    const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
    requests.push(body);
    if (requests.length <= (options.failChatCount ?? 0)) {
      response.destroy(new Error('Fixture interrupted the request.'));
      return;
    }
    sendJson(response, 200, {
      id: 'chatcmpl-fixture',
      model: body.model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: `CLI fixture answer from ${String(body.model)}` },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
    });
    return;
  }
  sendJson(response, 404, { error: { message: 'fixture path not found' } });
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => chunks.push(chunk));
    request.once('end', () => resolve(chunks.join('')));
    request.once('error', reject);
  });
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function occurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}
