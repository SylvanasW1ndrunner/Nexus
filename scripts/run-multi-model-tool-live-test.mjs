import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { OpenAICompatibleProvider } from '../packages/core-llm/dist/index.js';
import { DatabaseAgentRuntime } from '../packages/sdk/dist/index.js';
import { loadEnvFile } from './load-env.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
await loadEnvFile(join(root, '.env'));

const apiKey = process.env.TEST_SILICONFLOW_API_KEY ?? process.env.DBAGENT_LLM_API_KEY;
assert.ok(apiKey, '需要 TEST_SILICONFLOW_API_KEY 或 DBAGENT_LLM_API_KEY。');
const baseUrl = process.env.DBAGENT_LLM_BASE_URL ?? 'https://api.siliconflow.cn/v1';
const preferredModels = parseModels(process.env.DBAGENT_MULTI_MODEL_LIVE_MODELS) ?? [
  'deepseek-ai/DeepSeek-V4-Pro',
  'Qwen/Qwen3.6-35B-A3B',
  'MiniMaxAI/MiniMax-M2.5',
  'zai-org/GLM-4.5-Air',
];

const provider = new OpenAICompatibleProvider({
  id: 'siliconflow',
  name: 'SiliconFlow live compatibility',
  baseUrl,
  apiKey,
  timeoutMs: 180_000,
  maxRetries: 1,
});
const availableModels = new Set(await provider.listModels());
const models = preferredModels.filter((model) => availableModels.has(model));
assert.equal(
  models.length,
  preferredModels.length,
  `候选模型未全部出现在 Endpoint：${preferredModels.filter((model) => !availableModels.has(model)).join(', ')}`,
);

const runtime = new DatabaseAgentRuntime({
  provider,
  model: models[0],
  tenantId: 'multi-model-live',
  sessionDatabasePath: ':memory:',
});
const runs = [];

try {
  for (const model of models) {
    const startedAt = performance.now();
    const run = { model, passed: false };
    try {
      runtime.configureProvider(provider, model, {
        generation: { temperature: 0.1, maxOutputTokens: 4096 },
      });
      const metadata = runtime.llmModels().find(
        (candidate) => candidate.providerId === provider.id && candidate.model === model,
      );
      assert.ok(metadata, `模型未进入 Runtime 注册表：${model}`);
      assert.notEqual(metadata.limits.contextTokens, 32_768, `${model} 被错误回退为 32K。`);
      assert.ok(metadata.limits.contextTokens, `${model} 未从内置目录解析出上下文。`);
      Object.assign(run, {
        contextTokens: metadata.limits.contextTokens,
        maxOutputTokens: metadata.limits.maxOutputTokens,
        metadataSource: metadata.discovery?.source ?? 'unknown',
      });

      const first = await runtime.llmChat(
        {
          messages: [
            {
              role: 'system',
              content:
                'Use the provided tool exactly once. Do not print XML, JSON tool markup, or a final answer before the tool result.',
            },
            { role: 'user', content: '请调用 lookup_metric 查询 orders 指标。' },
          ],
          tools: [
            {
              name: 'lookup_metric',
              description: 'Return one named metric.',
              inputSchema: {
                type: 'object',
                properties: { name: { type: 'string', enum: ['orders'] } },
                required: ['name'],
                additionalProperties: false,
              },
            },
          ],
          temperature: 0.1,
          maxTokens: 4096,
        },
        {
          taskType: 'multi-model-native-tool-call',
          timeoutMs: 180_000,
          maxRetries: 0,
          maxFallbacks: 0,
        },
      );
      run.firstResponse = {
        finishReason: first.finishReason ?? null,
        toolCallCount: first.toolCalls.length,
        textPreview: preview(first.text),
        usage: first.usage ?? null,
      };
      assert.equal(first.toolCalls.length, 1, `${model} 没有返回一个结构化 Tool Call。`);
      assert.equal(first.toolCalls[0]?.name, 'lookup_metric');
      assert.equal(first.toolCalls[0]?.arguments.name, 'orders');
      assert.doesNotMatch(first.text, /<\/?tool[_-]?calls?\b/i);

      const call = first.toolCalls[0];
      const second = await runtime.llmChat(
        {
          messages: [
            { role: 'user', content: '请调用 lookup_metric 查询 orders 指标，并交付结果。' },
            { role: 'assistant', content: first.text, toolCalls: first.toolCalls },
            {
              role: 'tool',
              toolCallId: call.id,
              toolName: call.name,
              content: '{"name":"orders","value":42}',
            },
          ],
          tools: [
            {
              name: 'lookup_metric',
              description: 'Return one named metric.',
              inputSchema: {
                type: 'object',
                properties: { name: { type: 'string', enum: ['orders'] } },
                required: ['name'],
                additionalProperties: false,
              },
            },
          ],
          temperature: 0.1,
          maxTokens: 4096,
        },
        {
          taskType: 'multi-model-native-tool-result',
          timeoutMs: 180_000,
          maxRetries: 0,
          maxFallbacks: 0,
        },
      );
      run.finalResponse = {
        finishReason: second.finishReason ?? null,
        toolCallCount: second.toolCalls.length,
        textPreview: preview(second.text),
        usage: second.usage ?? null,
      };
      assert.equal(second.toolCalls.length, 0, `${model} 收到结果后仍重复调用了工具。`);
      assert.match(second.text, /42/);
      assert.doesNotMatch(second.text, /<\/?tool[_-]?calls?\b/i);
      Object.assign(run, {
        passed: true,
        latencyMs: Math.round(performance.now() - startedAt),
        usage: {
          first: first.usage ?? null,
          second: second.usage ?? null,
        },
      });
    } catch (error) {
      Object.assign(run, {
        latencyMs: Math.round(performance.now() - startedAt),
        error: serializeError(error),
      });
    }
    runs.push(run);
  }
} finally {
  await runtime.close();
}

const report = {
  kind: 'multi-model-native-tool-compatibility',
  generatedAt: new Date().toISOString(),
  provider: 'siliconflow',
  protocol: 'openai-chat',
  passed: runs.length === models.length && runs.every((run) => run.passed),
  models: runs,
};
const reportPath = join(root, 'reports', 'llm-platform', 'multi-model-tool-live.json');
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report, null, 2));
console.log(`Report: ${reportPath}`);
if (!report.passed) process.exitCode = 1;

function parseModels(value) {
  if (!value?.trim()) return undefined;
  const models = value
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean);
  if (models.length < 2) throw new Error('DBAGENT_MULTI_MODEL_LIVE_MODELS 至少包含两个模型。');
  return models;
}

function preview(value) {
  return value.trim().replace(/\s+/g, ' ').slice(0, 500);
}

function serializeError(error) {
  if (!(error instanceof Error)) return { name: 'UnknownError', message: String(error) };
  return {
    name: error.name,
    message: error.message,
    ...(typeof error.code === 'string' ? { code: error.code } : {}),
    ...(typeof error.statusCode === 'number' ? { statusCode: error.statusCode } : {}),
  };
}
