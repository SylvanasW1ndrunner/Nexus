import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { createNotRunLiveReport } from './lib/live-agent-report.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

const apiKey =
  process.env.TEST_LLM_API_KEY ??
  process.env.TEST_SILICONFLOW_API_KEY;
const endpoint =
  process.env.TEST_LLM_ENDPOINT ??
  process.env.TEST_SILICONFLOW_BASE_URL ??
  'https://api.siliconflow.cn/v1';
const configuredModelsInput = process.env.TEST_LLM_MODELS;
const preferredModels = [
  'deepseek-ai/DeepSeek-V4-Pro',
  'Qwen/Qwen3.6-35B-A3B',
  'MiniMaxAI/MiniMax-M2.5',
  'zai-org/GLM-4.5-Air',
];
const reportPath = join(root, 'reports', 'llm-platform', 'multi-model-live.json');
let report;

if (!apiKey) {
  report = createNotRunLiveReport({
    kind: 'multi-model-user-acceptance',
    reason: 'TEST_LLM_API_KEY or TEST_SILICONFLOW_API_KEY is required.',
    endpointOrigin: publicEndpointOrigin(endpoint),
  });
} else {
  const projectDirectory = await mkdtemp(join(tmpdir(), 'schemanaut-multi-model-live-'));
  const { AgentRuntime, GlobalConfigStore } = await import('../packages/agent-host/dist/index.js');
  const { LlmConnectionManager } = await import('../packages/core-llm/dist/index.js');
  const llmManager = new LlmConnectionManager({ cacheDirectory: join(projectDirectory, 'llm-cache') });
  llmManager.replaceConnections([{ name: 'Live endpoint', endpoint, apiKey }]);
  const runtime = new AgentRuntime({
    projectDirectory,
    stateDatabasePath: ':memory:',
    llmManager,
    globalConfigStore: new GlobalConfigStore({ path: join(projectDirectory, 'config.toml') }),
  });
  const runs = [];
  let routeProtocol = 'unknown';
  let setupError;
  let configuredModels;

  try {
    configuredModels = parseModels(configuredModelsInput);
    const connection = runtime.listLlmConnections()[0];
    assert.ok(connection, 'The injected live endpoint was not available.');
    const discovery = await runtime.discoverLlmConnection({ connectionId: connection.id });
    routeProtocol = discovery.resolution.protocol;
    const generationModels = discovery.catalog.models.filter(
      (model) => model.roles.generation.value !== false,
    );
    const available = new Set(generationModels.map((model) => model.modelId));
    const requested = configuredModels ?? preferredModels;
    const selected = requested.filter((model) => available.has(model));
    for (const model of generationModels) {
      if (selected.length >= 3) break;
      if (!selected.includes(model.modelId)) selected.push(model.modelId);
    }
    assert.ok(
      selected.length >= 3,
      `At least three generation models are required; found ${selected.length}.`,
    );

  for (const modelId of selected.slice(0, Math.max(3, configuredModels?.length ?? 3))) {
    const startedAt = performance.now();
    const run = { modelId, passed: false };
    try {
      const prepared = await runtime.previewModelParameters({
        connectionId: connection.id,
        modelId,
      });
      const selection = { connectionId: connection.id, modelId };
      const temperature =
        generationModels.find((candidate) => candidate.modelId === modelId)?.generationParameters.temperature.value === 'unsupported'
          ? undefined
          : 0.1;
      const requestParameters = temperature === undefined ? {} : { temperature };

      const basicStartedAt = performance.now();
      const basic = await runtime.llmChat(
        {
          messages: [{ role: 'user', content: 'Reply with exactly: SCHEMANAUT_LIVE_OK' }],
          ...requestParameters,
        },
        { model: selection, taskType: 'live-basic', timeoutMs: 180_000, maxRetries: 1 },
      );
      assert.match(basic.text, /SCHEMANAUT_LIVE_OK/i);

      const streamStartedAt = performance.now();
      let streamedText = '';
      let firstStreamEventMs;
      for await (const event of runtime.llmStream(
        {
          messages: [{ role: 'user', content: 'Reply with exactly: STREAM_OK' }],
          ...requestParameters,
        },
        { model: selection, taskType: 'live-stream', timeoutMs: 180_000, maxRetries: 1 },
      )) {
        firstStreamEventMs ??= Math.round(performance.now() - streamStartedAt);
        if (event.type === 'text-delta') streamedText += event.text;
      }
      assert.match(streamedText, /STREAM_OK/i);

      const toolStartedAt = performance.now();
      const toolRequest = await runtime.llmChat(
        {
          messages: [
            {
              role: 'system',
              content: 'Call lookup_metric exactly once. Do not print a textual tool-call representation.',
            },
            { role: 'user', content: 'Use lookup_metric to get the orders metric.' },
          ],
          tools: [metricTool()],
          ...requestParameters,
        },
        { model: selection, taskType: 'live-tool-call', timeoutMs: 180_000, maxRetries: 1 },
      );
      assert.equal(toolRequest.toolCalls.length, 1);
      assert.equal(toolRequest.toolCalls[0]?.name, 'lookup_metric');
      assert.equal(toolRequest.toolCalls[0]?.arguments.name, 'orders');
      assert.doesNotMatch(toolRequest.text, /<\/?tool[_-]?calls?\b/i);

      const call = toolRequest.toolCalls[0];
      const final = await runtime.llmChat(
        {
          messages: [
            { role: 'user', content: 'Use lookup_metric to get the orders metric and deliver it.' },
            { role: 'assistant', content: toolRequest.text, toolCalls: toolRequest.toolCalls },
            {
              role: 'tool',
              toolCallId: call.id,
              toolName: call.name,
              content: '{"name":"orders","value":42}',
            },
          ],
          tools: [metricTool()],
          ...requestParameters,
        },
        { model: selection, taskType: 'live-tool-result', timeoutMs: 180_000, maxRetries: 1 },
      );
      assert.equal(final.toolCalls.length, 0);
      assert.match(final.text, /42/);
      assert.doesNotMatch(final.text, /<\/?tool[_-]?calls?\b/i);

      Object.assign(run, {
        passed: true,
        contextTokens: prepared.contextTokens.value,
        contextSource: prepared.contextTokens.source,
        toolCalling: generationModels.find((candidate) => candidate.modelId === modelId)?.capabilities.toolCalling.value,
        effectiveParameters: requestParameters,
        basicLatencyMs: Math.round(performance.now() - basicStartedAt),
        firstStreamEventMs: firstStreamEventMs ?? null,
        toolCallLatencyMs: Math.round(performance.now() - toolStartedAt),
        totalLatencyMs: Math.round(performance.now() - startedAt),
        usage: {
          basic: basic.usage ?? null,
          toolRequest: toolRequest.usage ?? null,
          final: final.usage ?? null,
        },
      });
    } catch (error) {
      Object.assign(run, {
        totalLatencyMs: Math.round(performance.now() - startedAt),
        error: serializeError(error, apiKey),
      });
    }
    runs.push(run);
    }
  } catch (error) {
    setupError = serializeError(error, apiKey);
  } finally {
    await runtime.close().catch(() => undefined);
    await rm(projectDirectory, { recursive: true, force: true });
  }

  const passed = setupError === undefined && runs.length >= 3 && runs.every((run) => run.passed);
  report = {
    kind: 'multi-model-user-acceptance',
    generatedAt: new Date().toISOString(),
    status: passed ? 'passed' : 'failed',
    endpointOrigin: publicEndpointOrigin(endpoint),
    routeProtocol,
    passed,
    ...(setupError === undefined ? {} : { setupError }),
    runs,
  };
}
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report, null, 2));
console.log(`Report: ${reportPath}`);
if (report.status === 'failed') process.exitCode = 1;

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

function parseModels(value) {
  if (!value?.trim()) return undefined;
  const models = [...new Set(value.split(',').map((model) => model.trim()).filter(Boolean))];
  if (models.length < 3) throw new Error('TEST_LLM_MODELS must contain at least three models.');
  return models;
}

function serializeError(error, secret) {
  if (!(error instanceof Error)) {
    return { name: 'UnknownError', message: redact(String(error), secret) };
  }
  return {
    name: error.name,
    message: redact(error.message, secret),
    ...(typeof error.code === 'string' ? { code: error.code } : {}),
    ...(typeof error.statusCode === 'number' ? { statusCode: error.statusCode } : {}),
  };
}

function redact(value, secret) {
  return secret ? value.replaceAll(secret, '[REDACTED]') : value;
}

function publicEndpointOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return 'invalid-endpoint';
  }
}
