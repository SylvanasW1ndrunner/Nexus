#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import { cpus, platform, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  BASE_TOOL_MANIFEST,
  CapabilityControlPlane,
  ToolExposurePlanner,
  ToolRegistry,
} from '../packages/core-agent/dist/index.js';

const repositoryRoot = resolve(import.meta.dirname, '..');
const reportDirectory = join(repositoryRoot, 'reports', 'capability-runtime');
const reportPath = resolve(
  process.env.SCHEMANAUT_CAPABILITY_BENCHMARK_REPORT_PATH ??
    join(reportDirectory, 'performance.json'),
);
const contractProfile = process.env.SCHEMANAUT_CAPABILITY_BENCHMARK_PROFILE === 'contract';
const sizes = [1_000, 10_000];
const thresholds = {
  registrationMs: 5_000,
  capabilitySnapshotP95Ms: 500,
  capabilityDiscoveryP95Ms: 750,
  capabilityActivationMs: 750,
  toolSnapshotP95Ms: 500,
  toolExposureP95Ms: 500,
  unrelatedOwnerRefreshP95Ms: 500,
  modelToolCount: BASE_TOOL_MANIFEST.length,
  modelSchemaChars: 4_000,
};
const results = [];

for (const size of sizes) results.push(await benchmarkSize(size));

const largest = results.at(-1);
if (!largest) throw new Error('The 10k benchmark did not run.');
const checks = {
  registration: largest.registration.elapsedMs < thresholds.registrationMs,
  capabilitySnapshot:
    largest.capabilitySnapshot.p95Ms < thresholds.capabilitySnapshotP95Ms,
  capabilityDiscovery:
    largest.capabilityDiscovery.p95Ms < thresholds.capabilityDiscoveryP95Ms,
  capabilityActivation:
    largest.capabilityActivation.elapsedMs < thresholds.capabilityActivationMs,
  toolSnapshot: largest.toolSnapshot.p95Ms < thresholds.toolSnapshotP95Ms,
  toolExposure: largest.toolExposure.p95Ms < thresholds.toolExposureP95Ms,
  unrelatedOwnerRefresh:
    largest.unrelatedOwnerRefresh.p95Ms < thresholds.unrelatedOwnerRefreshP95Ms,
  stableToolRevision: largest.unrelatedOwnerRefresh.catalogToolRevisionStable,
  boundedDirectTools: largest.toolExposure.modelToolCount === thresholds.modelToolCount,
  boundedModelSchema: largest.toolExposure.modelSchemaChars < thresholds.modelSchemaChars,
};
const passed = Object.values(checks).every(Boolean);

const report = {
  schemaVersion: 1,
  kind: 'capability-runtime-performance',
  status: passed ? 'passed' : 'failed',
  generatedAt: new Date().toISOString(),
  environment: {
    node: process.version,
    platform: `${platform()} ${release()}`,
    cpuCount: cpus().length,
  },
  thresholds,
  checks,
  results,
};
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`Capability benchmark report: ${reportPath}\n`);
if (!passed) process.exitCode = 1;

async function benchmarkSize(size) {
  const control = new CapabilityControlPlane();
  const registrationStarted = performance.now();
  for (let index = 0; index < size; index += 1) {
    const suffix = String(index).padStart(5, '0');
    control.register({
      manifest: {
        id: `fixture.module.${suffix}`,
        version: '1.0.0',
        description: `Benchmark capability target-${suffix}`,
        capabilities: [
          {
            id: `fixture.capability.${suffix}`,
            description: `Fixture capability target-${suffix}`,
          },
        ],
      },
      instanceId: 'primary',
      load: () => ({
        probe: () => ({ status: 'available' }),
        activate: () => ({ contributions: {} }),
      }),
    });
  }
  const registrationElapsed = performance.now() - registrationStarted;

  const capabilitySnapshot = sample(() => control.snapshot());
  const targetSuffix = String(size - 1).padStart(5, '0');
  const targetModuleId = `fixture.module.${targetSuffix}`;
  const targetCapabilityName = `fixture.capability.${targetSuffix}`;
  const capabilityDiscovery = sample(() => {
    const discovery = control.captureDiscoveryManifest();
    if (!discovery.some((entry) => entry.name === targetCapabilityName)) {
      throw new Error(`Discovery manifest did not contain ${targetCapabilityName}.`);
    }
  });
  const activationStarted = performance.now();
  await control.activate({ moduleId: targetModuleId, instanceId: 'primary' });
  const capabilityActivation = { elapsedMs: round(performance.now() - activationStarted) };

  const tools = new ToolRegistry();
  tools.publishBaselineInvocations(BASE_TOOL_MANIFEST.map(({ name, schemaRevision }) => baselineContribution(name, schemaRevision)));
  tools.replaceOwnerInvocations(
    'fixture:catalog',
    Array.from({ length: size }, (_, index) => deferredContribution(`fixture_tool_${String(index).padStart(5, '0')}`, () => ({ index }))),
  );
  const stableToolName = 'fixture_tool_00000';
  const stableToolRevision = invocationRevision(tools, stableToolName);
  let unrelatedGeneration = 0;
  const unrelatedOwnerRefresh = sample(() => {
    unrelatedGeneration += 1;
    tools.replaceOwnerInvocations('fixture:unrelated-owner', [
      deferredContribution('unrelated_owner_tool', () => ({ generation: unrelatedGeneration }), `unrelated_owner_tool@${unrelatedGeneration}`),
    ]);
  });
  const toolSnapshot = sample(() => {
    const snapshot = tools.captureSnapshot();
    snapshot.release();
  });
  const snapshot = tools.captureSnapshot();
  const planner = new ToolExposurePlanner();
  let lastPlan;
  const toolExposure = sample(() => {
    lastPlan = planner.plan({ registry: snapshot, dynamicDiscovery: true });
  });
  snapshot.release();
  if (!lastPlan) throw new Error('Tool exposure plan was not produced.');

  await control.close();
  return {
    size,
    registration: { elapsedMs: round(registrationElapsed) },
    capabilitySnapshot,
    capabilityDiscovery,
    capabilityActivation,
    toolSnapshot,
    unrelatedOwnerRefresh: {
      ...unrelatedOwnerRefresh,
      catalogToolRevisionStable: invocationRevision(tools, stableToolName) === stableToolRevision,
    },
    toolExposure: {
      ...toolExposure,
      modelToolCount: lastPlan.modelTools.length,
      discoverableToolCount: lastPlan.discoverable.length,
      modelSchemaChars: JSON.stringify(lastPlan.modelTools).length,
    },
  };
}

function invocationRevision(registry, name) {
  const snapshot = registry.captureSnapshot();
  try { return snapshot.invocationRevision(name); }
  finally { snapshot.release(); }
}

function sample(operation, warmup = contractProfile ? 1 : 5, count = contractProfile ? 5 : 30) {
  for (let index = 0; index < warmup; index += 1) operation();
  const samples = [];
  for (let index = 0; index < count; index += 1) {
    const started = performance.now();
    operation();
    samples.push(performance.now() - started);
  }
  return summarize(samples);
}

function summarize(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    p50Ms: round(percentile(sorted, 0.5)),
    p95Ms: round(percentile(sorted, 0.95)),
    maxMs: round(sorted.at(-1) ?? 0),
    rawSamplesMs: samples.map(round),
  };
}

function percentile(sorted, ratio) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

function round(value) {
  return Math.round(value * 1_000) / 1_000;
}

function baselineContribution(name, schemaRevision) {
  const definition = currentToolDefinition(name, 'direct', 'runtime', schemaRevision);
  return { definition, runtime: currentToolRuntime(definition, () => name === 'tool_search' ? { tools: [] } : name === 'skill' ? { loaded: true } : {}) };
}

function deferredContribution(name, execute, handlerRevision = `${name}@1`) {
  const definition = { ...deferredTool(name), handlerRevision };
  return { definition, runtime: currentToolRuntime(definition, execute) };
}

function currentToolDefinition(name, exposure, source, toolRevision = `${name}@1`) {
  return {
    name,
    description: name,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: { type: 'object' },
    dangerLevel: 'safe',
    readonly: true,
    source,
    access: 'read',
    recoveryClass: 'read',
    toolRevision,
    handlerRevision: `${name}@1`,
    intentRevision: 'prepared-tool-intent.v1',
    limits: benchmarkToolLimits(),
    permission: { actions: ['read'] },
    execution: { concurrency: 'read', timeoutMs: 1_000 },
    failurePolicy: { onUnknown: { failureKind: 'unknown', retryable: false } },
    exposure,
  };
}

function deferredTool(name) {
  return { ...currentToolDefinition(name, 'deferred', 'capability-benchmark'), description: `Deferred benchmark Tool ${name}`, inputSchema: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    } };
}

function benchmarkToolLimits() { return { timeoutMs: 1_000, maxInputBytes: 4_096, maxOutputBytes: 65_536, maxArtifactBytes: 1_048_576, maxDepth: 8, maxRecords: 128 }; }
function currentToolRuntime(definition, execute) { return { revision: { toolName: definition.name, toolRevision: definition.toolRevision, handlerRevision: definition.handlerRevision, intentRevision: definition.intentRevision }, prepare: (input, context) => ({ input, toolRevision: context.toolRevision, handlerRevision: context.handlerRevision, intentRevision: context.intentRevision, targetIdentity: null, generation: context.generation, action: { summary: `Run benchmark Tool ${definition.name}.` }, permission: { toolName: definition.name, dangerLevel: 'safe', readonly: true, access: 'read', recoveryClass: 'read', actions: ['read'], paths: [], hosts: [], network: false, externalWrite: false, destructive: false, credentials: false, admin: false, unknownRisk: false, resolvedAddresses: [], targets: [] }, access: 'read', recoveryClass: 'read', concurrency: 'read', resourceKeys: [`benchmark:${definition.name}`], limits: context.limits }), execute }; }
