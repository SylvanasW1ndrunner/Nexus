#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import { cpus, platform, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { ResourceRegistry } from '../packages/core-resource/dist/index.js';

const root = resolve(import.meta.dirname, '..');
const reportPath = join(root, 'reports', 'resource-state', 'performance.json');
const RESOURCE_COUNT = 100_000;
const RELATION_COUNT = 100_000;
const ID_LOOKUP_SAMPLES = 2_000;
const RELATION_LOOKUP_SAMPLES = 2_000;
const TRAVERSAL_SAMPLES = 1_000;
const QUERY_SAMPLES = 1_000;
const UPDATE_SAMPLES = 10_000;
const STATE_SAMPLES = 2_000;
const BOUNDED_OBSERVATION_WRITES = 1_000_000;
const time = '2026-07-23T00:00:00.000Z';
const expiresAt = '2099-01-01T00:00:00.000Z';
const source = {
  sourceId: 'resource-benchmark',
  sourceType: 'connector',
  observedAt: time,
};
const registry = new ResourceRegistry({
  maxEvents: 512,
  maxObservationsPerResource: 4,
});

for (let index = 0; index < RESOURCE_COUNT; index += 1) {
  registry.upsertResource(benchmarkResource(index));
}
for (let index = 0; index < RESOURCE_COUNT - 1; index += 1) {
  registry.upsertRelation({
    id: relationId(index),
    kind: 'contains',
    fromResourceId: resourceId(index),
    toResourceId: resourceId(index + 1),
    version: 1,
    firstSeenAt: time,
    updatedAt: time,
    sources: [source],
  });
}
registry.upsertRelation({
  id: relationId(RESOURCE_COUNT - 1),
  kind: 'depends_on',
  fromResourceId: resourceId(RESOURCE_COUNT - 1),
  toResourceId: resourceId(0),
  version: 1,
  firstSeenAt: time,
  updatedAt: time,
  sources: [source],
});
if (registry.size !== RESOURCE_COUNT || registry.relationCount !== RELATION_COUNT) {
  throw new Error('Resource benchmark graph was not constructed completely');
}

const idLookupDurations = measure(ID_LOOKUP_SAMPLES, (index) => {
  const id = resourceId((index * 7_919) % RESOURCE_COUNT);
  if (!registry.getResource(id)) throw new Error(`Missing resource ${id}`);
});
const relationLookupDurations = measure(RELATION_LOOKUP_SAMPLES, (index) => {
  const id = resourceId((index * 7_919) % RESOURCE_COUNT);
  const count = registry.relationsFor(id).length;
  if (count < 1 || count > 3) {
    throw new Error(`Unexpected relation count ${count} for ${id}`);
  }
});
const traversalDurations = measure(TRAVERSAL_SAMPLES, (index) => {
  const start = (index * 7_919) % (RESOURCE_COUNT - 3);
  const result = registry.traverse({
    startResourceIds: [resourceId(start)],
    direction: 'outgoing',
    relationKinds: ['contains'],
    maxDepth: 2,
    maxResources: 10,
  });
  if (result.nodes.length !== 3 || result.truncated) {
    throw new Error(`Unexpected traversal result at ${start}`);
  }
});
registry.query({
  kinds: ['table'],
  scope: { tenantId: 'benchmark', projectId: 'project-4' },
  limit: 100,
});
const scopedQueryDurations = measure(QUERY_SAMPLES, () => {
  const result = registry.query({
    kinds: ['table'],
    scope: { tenantId: 'benchmark', projectId: 'project-4' },
    limit: 100,
  });
  if (result.items.length !== 100) {
    throw new Error('Scope and kind query did not return a complete page');
  }
});

const snapshot = registry.snapshot();
forceGc();
const restored = new ResourceRegistry({
  maxEvents: 512,
  maxObservationsPerResource: 4,
});
const restoreStartedAt = performance.now();
restored.restore(snapshot);
const snapshotRestoreMs = performance.now() - restoreStartedAt;
if (
  restored.size !== RESOURCE_COUNT ||
  restored.relationCount !== RELATION_COUNT
) {
  throw new Error('Snapshot restore lost resource graph data');
}
restored.clear();
forceGc();

for (let index = 0; index < RESOURCE_COUNT; index += 1) {
  registry.addObservation({
    id: `state-observation-${index}`,
    resourceId: resourceId(index),
    category: 'health',
    status: index % 20 === 0 ? 'degraded' : 'healthy',
    observedAt: time,
    expiresAt,
    source,
  });
}
const stateDurations = measure(STATE_SAMPLES, (index) => {
  const resourceIndex = (index * 7_919) % RESOURCE_COUNT;
  const state = registry.state(resourceId(resourceIndex), { asOf: time });
  if (!state || state.freshness !== 'fresh') {
    throw new Error(`State was not derived for resource ${resourceIndex}`);
  }
});

const updateTargetId = resourceId(RESOURCE_COUNT >> 1);
const updateDurations = measure(UPDATE_SAMPLES, (index) => {
  registry.upsertResource({
    ...benchmarkResource(RESOURCE_COUNT >> 1),
    version: index + 2,
    attributes: { updateSequence: index },
  });
});
if (
  registry.getResource(updateTargetId)?.attributes?.updateSequence !==
  UPDATE_SAMPLES - 1
) {
  throw new Error('Incremental updates did not preserve the latest resource value');
}

const boundedRegistry = new ResourceRegistry({
  maxEvents: 64,
  maxObservationsPerResource: 32,
});
const boundedResource = {
  ...benchmarkResource(0),
  id: 'bounded-observation-resource',
  nativeId: 'bounded-observation-resource',
  canonicalName: 'bounded-observation-resource',
};
boundedRegistry.upsertResource(boundedResource);
const boundedStartedAt = performance.now();
for (let index = 0; index < BOUNDED_OBSERVATION_WRITES; index += 1) {
  boundedRegistry.addObservation({
    id: `bounded-observation-${index}`,
    resourceId: boundedResource.id,
    category: 'health',
    status: index % 2 === 0 ? 'healthy' : 'degraded',
    observedAt: time,
    expiresAt,
    source,
  });
}
const boundedObservationElapsedMs = performance.now() - boundedStartedAt;

const metrics = {
  resourceIdLookupP95Ms: percentile(idLookupDurations, 0.95),
  singleHopRelationP95Ms: percentile(relationLookupDurations, 0.95),
  twoHopTraversalP95Ms: percentile(traversalDurations, 0.95),
  scopeAndKindQueryP95Ms: percentile(scopedQueryDurations, 0.95),
  incrementalUpdateP95Ms: percentile(updateDurations, 0.95),
  stateDerivationP95Ms: percentile(stateDurations, 0.95),
  snapshotRestoreMs,
  retainedObservations: boundedRegistry.observationCount,
  retainedEvents: boundedRegistry.eventCount,
  boundedObservationElapsedMs,
};
const thresholds = {
  resourceIdLookupP95Ms: 10,
  singleHopRelationP95Ms: 50,
  twoHopTraversalP95Ms: 100,
  scopeAndKindQueryP95Ms: 50,
  incrementalUpdateP95Ms: 5,
  stateDerivationP95Ms: 10,
  snapshotRestoreMs: 5_000,
  retainedObservations: 32,
  retainedEvents: 64,
};
const checks = Object.fromEntries(
  Object.entries(thresholds).map(([name, maximum]) => [
    name,
    {
      actual: metrics[name],
      maximum,
      passed: metrics[name] <= maximum,
    },
  ]),
);
const report = {
  kind: 'resource-state-performance',
  status: Object.values(checks).every((check) => check.passed)
    ? 'passed'
    : 'failed',
  generatedAt: new Date().toISOString(),
  environment: environment(),
  dataset: {
    resources: RESOURCE_COUNT,
    relations: RELATION_COUNT,
    validObservations: RESOURCE_COUNT,
    idLookupSamples: ID_LOOKUP_SAMPLES,
    relationLookupSamples: RELATION_LOOKUP_SAMPLES,
    traversalSamples: TRAVERSAL_SAMPLES,
    querySamples: QUERY_SAMPLES,
    updateSamples: UPDATE_SAMPLES,
    stateSamples: STATE_SAMPLES,
    boundedObservationWrites: BOUNDED_OBSERVATION_WRITES,
  },
  thresholds,
  metrics,
  checks,
  measurement:
    'Deterministic in-memory resource runtime; external database, disk and network time excluded.',
};

await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify(report, null, 2)}\nReport: ${reportPath}\n`);
if (report.status !== 'passed') process.exitCode = 1;

function benchmarkResource(index) {
  return {
    id: resourceId(index),
    kind: index % 2 === 0 ? 'table' : 'view',
    nativeId: `analytics.public.object_${index}`,
    canonicalName: `analytics.public.object_${index}`,
    engine: 'benchmark',
    scope: {
      tenantId: 'benchmark',
      projectId: `project-${index % 10}`,
      environment: 'test',
    },
    attributes: { ordinal: index },
    version: 1,
    firstSeenAt: time,
    updatedAt: time,
    sources: [source],
  };
}

function resourceId(index) {
  return `resource-${String(index).padStart(6, '0')}`;
}

function relationId(index) {
  return `relation-${String(index).padStart(6, '0')}`;
}

function measure(samples, operation) {
  for (let index = 0; index < 100; index += 1) operation(index % samples);
  const durations = [];
  for (let index = 0; index < samples; index += 1) {
    const startedAt = performance.now();
    operation(index);
    durations.push(performance.now() - startedAt);
  }
  return durations;
}

function percentile(values, quantile) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[
    Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)
  ];
}

function environment() {
  return {
    node: process.version,
    platform: platform(),
    release: release(),
    cpu: cpus()[0]?.model ?? 'unknown',
    cpuCount: cpus().length,
    memory: {
      rssMiB: bytesToMiB(process.memoryUsage().rss),
      heapUsedMiB: bytesToMiB(process.memoryUsage().heapUsed),
    },
  };
}

function bytesToMiB(value) {
  return Number((value / 1024 / 1024).toFixed(2));
}

function forceGc() {
  globalThis.gc?.();
}
