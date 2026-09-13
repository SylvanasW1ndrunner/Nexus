#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { AgentRuntime, GlobalConfigStore } from '../packages/agent-host/dist/index.js';
import { LlmConnectionManager } from '../packages/core-llm/dist/index.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const endpoint = process.env.TEST_OLLAMA_ENDPOINT ?? 'http://127.0.0.1:11434';
const requestedModel = process.env.TEST_OLLAMA_MODEL;
const reportPath = join(root, 'reports', 'llm-platform', 'ollama-live.json');
const projectDirectory = await mkdtemp(join(tmpdir(), 'schemanaut-ollama-live-'));
const llmManager = new LlmConnectionManager({ cacheDirectory: join(projectDirectory, 'llm-cache') });
llmManager.replaceConnections([{ name: 'Local Ollama', endpoint }]);
const runtime = new AgentRuntime({
  projectDirectory,
  stateDatabasePath: join(projectDirectory, 'sessions.db'),
  llmManager,
  globalConfigStore: new GlobalConfigStore({ path: join(projectDirectory, 'config.toml') }),
});
const report = {
  kind: 'ollama-user-acceptance',
  status: 'failed',
  generatedAt: new Date().toISOString(),
  endpoint,
};
let failure;

try {
  await runtime.ready();
  const connection = runtime.listLlmConnections()[0];
  assert.ok(connection, 'Ollama 注入连接不可用。');

  const discoveryStartedAt = performance.now();
  const discovery = await runtime.discoverLlmConnection({
    connectionId: connection.id,
    ...(requestedModel === undefined ? {} : { inspectModelIds: [requestedModel] }),
  });
  const discoveryLatencyMs = performance.now() - discoveryStartedAt;
  const generationModels = runtime.listLlmModels({
    connectionId: connection.id,
    role: 'generation',
  });
  const model = requestedModel
    ? generationModels.find((candidate) => candidate.modelId === requestedModel)
    : generationModels[0];
  assert.ok(model, requestedModel ? `Ollama 未发现模型 ${requestedModel}。` : 'Ollama 没有生成模型。');
  const selection = { connectionId: connection.id, modelId: model.modelId };
  const prepared = await runtime.previewModelParameters(selection);
  Object.assign(report, {
    diagnostics: {
      catalogModel: {
        id: model.modelId,
        roles: model.roles,
        capabilities: model.capabilities,
      },
      discoveredModels: generationModels.map((candidate) => ({
        id: candidate.modelId,
        roles: candidate.roles,
        capabilities: candidate.capabilities,
      })),
    },
  });

  const basicStartedAt = performance.now();
  const basic = await runtime.llmChat(
    { messages: [{ role: 'user', content: '请用一句简短中文说明 PostgreSQL 是什么。' }], maxTokens: 96 },
    { model: selection, taskType: 'ollama-live-basic', timeoutMs: 180_000, maxRetries: 0 },
  );
  const basicLatencyMs = performance.now() - basicStartedAt;
  assert.ok(basic.text.trim(), 'Ollama 同步对话返回空文本。');

  const streamStartedAt = performance.now();
  let firstEventMs;
  let firstVisibleTextMs;
  let streamText = '';
  let streamFinished = false;
  for await (const event of runtime.llmStream(
    { messages: [{ role: 'user', content: '只回复：OLLAMA_STREAM_OK' }], maxTokens: 64 },
    { model: selection, taskType: 'ollama-live-stream', timeoutMs: 180_000, maxRetries: 0 },
  )) {
    firstEventMs ??= performance.now() - streamStartedAt;
    if (event.type === 'text-delta') {
      firstVisibleTextMs ??= performance.now() - streamStartedAt;
      streamText += event.text;
    }
    if (event.type === 'finish') streamFinished = true;
  }
  const streamLatencyMs = performance.now() - streamStartedAt;
  assert.ok(streamFinished, 'Ollama 流式对话缺少 finish 事件。');
  assert.ok(streamText.trim(), 'Ollama 流式对话返回空文本。');

  const tool = await verifyToolCalling(runtime, selection, model.capabilities.toolCalling.value);
  assert.equal(tool.runtimeSafetyPassed, true, 'Ollama 工具协议验收未满足运行时安全合同。');
  assert.equal(runtime.globalConfigPath(), join(projectDirectory, 'config.toml'));

  Object.assign(report, {
    status: 'passed',
    connection: {
      id: connection.id,
      pluginId: discovery.resolution.pluginId,
      protocol: discovery.resolution.protocol,
      discoveryLatencyMs: round(discoveryLatencyMs),
    },
    model: {
      id: prepared.model.modelId,
      contextTokens: prepared.contextTokens,
      maxInputTokens: prepared.maxInputTokens,
      maxOutputTokens: prepared.maxOutputTokens,
      toolCalling: model.capabilities.toolCalling,
    },
    basic: {
      latencyMs: round(basicLatencyMs),
      nonEmpty: true,
      usage: basic.usage ?? null,
    },
    stream: {
      firstEventMs: nullableRound(firstEventMs),
      firstVisibleTextMs: nullableRound(firstVisibleTextMs),
      totalLatencyMs: round(streamLatencyMs),
      nonEmpty: true,
    },
    tool,
    settingsContract: { injectedConnection: true, globalConfigPathIsTemporary: true },
  });
} catch (error) {
  failure = error;
  Object.assign(report, { error: serializeError(error) });
} finally {
  await runtime.close().catch(() => undefined);
  await rm(projectDirectory, { recursive: true, force: true });
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\nReport: ${reportPath}\n`);
}

if (failure || report.status !== 'passed') process.exitCode = 1;

async function verifyToolCalling(runtime, selection, advertised) {
  const startedAt = performance.now();
  try {
    const response = await runtime.llmChat(
      {
        messages: [
          { role: 'system', content: '调用 lookup_metric 一次，不要输出文本形式的工具标签。' },
          { role: 'user', content: '请调用 lookup_metric 查询 orders。' },
        ],
        tools: [metricTool()],
        maxTokens: 128,
      },
      { model: selection, taskType: 'ollama-live-tool', timeoutMs: 180_000, maxRetries: 0 },
    );
    const call = response.toolCalls[0];
    const passed =
      response.toolCalls.length === 1 &&
      call?.name === 'lookup_metric' &&
      call.arguments.name === 'orders' &&
      !/<\/?tool[_-]?calls?\b/i.test(response.text);
    return {
      advertised,
      blocking: false,
      attempted: true,
      passed,
      classification: passed
        ? 'native-tool-call'
        : 'endpoint-model-returned-text-instead-of-native-tool-call',
      runtimeSafetyPassed: passed || response.toolCalls.length === 0,
      latencyMs: round(performance.now() - startedAt),
      response: {
        toolCallCount: response.toolCalls.length,
        toolNames: response.toolCalls.map((call) => call.name),
        textPreview: response.text.slice(0, 500),
      },
      ...(passed ? {} : { error: { message: '模型没有返回预期的结构化 Tool Call。' } }),
    };
  } catch (error) {
    return {
      advertised,
      blocking: true,
      classification: 'provider-or-adapter-error',
      runtimeSafetyPassed: false,
      attempted: true,
      passed: false,
      latencyMs: round(performance.now() - startedAt),
      error: serializeError(error),
    };
  }
}

function metricTool() {
  return {
    name: 'lookup_metric',
    description: 'Return one named metric.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', enum: ['orders'] } },
      required: ['name'],
      additionalProperties: false,
    },
  };
}

function serializeError(error) {
  if (!(error instanceof Error)) return { name: 'UnknownError', message: String(error) };
  return {
    name: error.name,
    message: error.message,
    ...(typeof error.code === 'string' ? { code: error.code } : {}),
    ...(typeof error.statusCode === 'number' ? { statusCode: error.statusCode } : {}),
    ...(typeof error.detail === 'object' && error.detail !== null
      ? { detail: error.detail }
      : {}),
  };
}

function nullableRound(value) {
  return value === undefined ? null : round(value);
}

function round(value) {
  return Math.round(value * 100) / 100;
}
