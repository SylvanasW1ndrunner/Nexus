#!/usr/bin/env node

import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_URL = 'https://models.dev/api.json';
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '..');
const outputPath = resolve(
  repositoryRoot,
  'packages',
  'core-llm',
  'src',
  'model_prices_and_context_window.json',
);
const temporaryPath = `${outputPath}.tmp`;

const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 30_000);
timeout.unref?.();

try {
  const inputPath = inputFileArgument(process.argv.slice(2));
  const source = inputPath
    ? JSON.parse(await readFile(resolve(inputPath), 'utf8'))
    : await readRemoteCatalog(controller.signal);
  const snapshot = compactCatalog(source);
  const payload = `${JSON.stringify(snapshot, null, 2)}\n`;
  await writeFile(temporaryPath, payload, 'utf8');
  await rm(outputPath, { force: true });
  await rename(temporaryPath, outputPath);
  process.stdout.write(
    `model catalog: ${Object.keys(snapshot.providers).length} providers, ` +
      `${modelCount(snapshot)} models, ${Buffer.byteLength(payload)} bytes\n`,
  );
} finally {
  clearTimeout(timeout);
  await rm(temporaryPath, { force: true });
}

async function readRemoteCatalog(signal) {
  const response = await fetchCatalog(signal);
  if (!response.ok) {
    throw new Error(`models.dev returned HTTP ${response.status}.`);
  }
  return await response.json();
}

function inputFileArgument(args) {
  if (args.length === 0) return undefined;
  if (args.length !== 2 || args[0] !== '--input' || !args[1]) {
    throw new Error('Usage: node scripts/update-model-catalog.mjs [--input path-to-api.json]');
  }
  return args[1];
}

async function fetchCatalog(signal) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await fetch(SOURCE_URL, {
        headers: {
          accept: 'application/json',
          'user-agent': 'SchemaNaut-model-catalog-updater/1',
        },
        signal,
      });
    } catch (error) {
      lastError = error;
      if (signal.aborted || attempt === 3) break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 500));
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('models.dev request failed without an error object.');
}

function compactCatalog(source) {
  if (!isRecord(source)) throw new Error('models.dev response must be an object.');
  const providers = {};
  for (const providerId of Object.keys(source).sort()) {
    const provider = source[providerId];
    if (!isRecord(provider) || !isRecord(provider.models)) continue;
    const models = {};
    for (const modelId of Object.keys(provider.models).sort()) {
      const model = provider.models[modelId];
      if (!isRecord(model) || typeof model.name !== 'string' || !model.name.trim()) continue;
      const limits = compactLimits(model.limit);
      const capabilities = compactCapabilities(model);
      const cost = compactCost(model.cost);
      models[modelId] = {
        name: model.name.trim(),
        ...(typeof model.family === 'string' && model.family.trim()
          ? { family: model.family.trim() }
          : {}),
        ...(limits === undefined ? {} : { limits }),
        ...(capabilities === undefined ? {} : { capabilities }),
        ...(cost === undefined ? {} : { cost }),
      };
    }
    if (Object.keys(models).length > 0) providers[providerId] = { models };
  }
  return {
    schemaVersion: 1,
    source: {
      name: 'models.dev',
      url: SOURCE_URL,
      generatedAt: new Date().toISOString(),
    },
    providers,
  };
}

function compactLimits(value) {
  if (!isRecord(value)) return undefined;
  const limits = {
    ...(positiveSafeInteger(value.context) ? { context: value.context } : {}),
    ...(positiveSafeInteger(value.input) ? { input: value.input } : {}),
    ...(positiveSafeInteger(value.output) ? { output: value.output } : {}),
  };
  return Object.keys(limits).length === 0 ? undefined : limits;
}

function compactCapabilities(model) {
  const capabilities = {
    ...(typeof model.tool_call === 'boolean' ? { toolCalling: model.tool_call } : {}),
    ...(typeof model.reasoning === 'boolean' ? { reasoning: model.reasoning } : {}),
    ...(typeof model.structured_output === 'boolean'
      ? { structuredOutput: model.structured_output }
      : {}),
    ...(typeof model.temperature === 'boolean' ? { temperature: model.temperature } : {}),
  };
  return Object.keys(capabilities).length === 0 ? undefined : capabilities;
}

function compactCost(value) {
  if (!isRecord(value)) return undefined;
  const cost = {
    ...(nonNegativeFinite(value.input) ? { input: value.input } : {}),
    ...(nonNegativeFinite(value.output) ? { output: value.output } : {}),
    ...(nonNegativeFinite(value.cache_read) ? { cacheRead: value.cache_read } : {}),
  };
  return Object.keys(cost).length === 0 ? undefined : cost;
}

function positiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function nonNegativeFinite(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function modelCount(snapshot) {
  return Object.values(snapshot.providers).reduce(
    (count, provider) => count + Object.keys(provider.models).length,
    0,
  );
}
