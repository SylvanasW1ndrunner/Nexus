import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALL_DATABASE_CAPABILITIES,
  CapabilityResolver,
  ConnectorRegistry,
  DATABASE_CAPABILITIES,
  DatabaseAccessRuntime,
  PostgresConnector,
  ResourceRegistry,
} from '../packages/core-db/dist/index.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const reportPath = join(root, 'reports', 'database-access-performance.json');
const RESOURCE_COUNT = 100_000;
const LOOKUP_SAMPLES = 2_000;
const JOB_SAMPLES = 1_000;
const STREAM_ROWS = 1_000_000;
const timestamp = new Date().toISOString();
const source = {
  sourceId: 'database-benchmark',
  sourceType: 'connector',
  observedAt: timestamp,
};

const registry = new ResourceRegistry();
registry.upsertResource(resource('root', 'database'));
for (let index = 0; index < RESOURCE_COUNT; index += 1) {
  const child = resource(`item-${index}`, 'table');
  registry.upsertResource(child);
  registry.upsertRelation({
    id: `rel-${index}`,
    kind: 'contains',
    fromResourceId: 'root',
    toResourceId: child.id,
    version: 1,
    firstSeenAt: timestamp,
    updatedAt: timestamp,
    sources: [source],
  });
}

const idLookupDurations = measureSync(LOOKUP_SAMPLES, (index) => {
  const id = `item-${(index * 7919) % RESOURCE_COUNT}`;
  if (!registry.getResource(id)) throw new Error(`Missing benchmark resource ${id}`);
});
const relationLookupDurations = measureSync(LOOKUP_SAMPLES, (index) => {
  const id = `item-${(index * 7919) % RESOURCE_COUNT}`;
  if (registry.relationsFor(id, { direction: 'incoming' }).length !== 1) {
    throw new Error(`Missing benchmark relation for ${id}`);
  }
});

const beforeIncrementalSize = registry.size;
const incrementalStarted = performance.now();
registry.applyChangeSet({
  sourceId: 'benchmark-incremental',
  version: '1',
  observedAt: timestamp,
  upsertResources: [
    resource('item-50000', 'table', {
      version: 2,
      attributes: { changed: true },
      updatedAt: new Date().toISOString(),
    }),
  ],
});
const incrementalMs = performance.now() - incrementalStarted;
if (registry.size !== beforeIncrementalSize) {
  throw new Error('Single-resource incremental update rebuilt or changed the resource set');
}

const resolver = new CapabilityResolver();
const capabilityDurations = measureSync(10_000, () => {
  const profile = resolver.resolve({
    connectorId: 'benchmark',
    engine: 'benchmark',
    layers: [
      {
        source: 'manifest',
        capabilities: {
          [DATABASE_CAPABILITIES.SQL_QUERY]: {
            key: DATABASE_CAPABILITIES.SQL_QUERY,
            status: 'supported',
            limits: { maximumRows: 10_000 },
          },
        },
      },
      {
        source: 'profile',
        capabilities: {
          [DATABASE_CAPABILITIES.SQL_WRITE]: {
            key: DATABASE_CAPABILITIES.SQL_WRITE,
            status: 'conditional',
            constraints: [{ name: 'approved', value: true }],
          },
        },
      },
    ],
    context: { approved: true },
  });
  resolver.require(profile, { key: DATABASE_CAPABILITIES.SQL_QUERY });
});

registry.clear();
forceGc();

const benchmarkConnector = createBenchmarkConnector();
const connectors = new ConnectorRegistry();
connectors.register(benchmarkConnector);
const runtime = new DatabaseAccessRuntime({ connectors, maxAuditEvents: JOB_SAMPLES * 3 });
const profile = {
  id: 'benchmark-profile',
  name: 'Benchmark profile',
  connectorId: benchmarkConnector.manifest.id,
  engine: benchmarkConnector.manifest.engine,
  endpoints: [{ transport: 'tcp', host: '127.0.0.1', port: 9999, database: 'benchmark' }],
  purpose: 'query',
  readOnly: true,
  createdAt: timestamp,
  updatedAt: timestamp,
};
runtime.createProfile(profile);
await runtime.connect(profile.id);

for (let index = 0; index < 100; index += 1) {
  await runtime.submit({ profileId: profile.id, sql: `select ${index} as warmup_value` });
}
const submitDurations = await measureAsync(JOB_SAMPLES, async (index) => {
  await runtime.submit({ profileId: profile.id, sql: `select ${index} as benchmark_value` });
});

const cancellableJobs = [];
for (let index = 0; index < JOB_SAMPLES; index += 1) {
  cancellableJobs.push(
    await runtime.submit({
      profileId: profile.id,
      sql: `select ${index} as queued_benchmark_value`,
    }),
  );
}
const cancelDurations = await measureAsync(JOB_SAMPLES, async (index) => {
  await runtime.cancel(cancellableJobs[index].id);
});

forceGc();
const streamJob = await runtime.submit({
  profileId: profile.id,
  sql: 'select * from benchmark_million_row_stream',
});
const baselineHeap = process.memoryUsage().heapUsed;
let peakHeap = baselineHeap;
let streamedRows = 0;
let batches = 0;
const streamStarted = performance.now();
for await (const batch of runtime.streamResult(streamJob.result.id, { batchSize: 1_000 })) {
  streamedRows += batch.rows.length;
  batches += 1;
  peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
  if (batches % 25 === 0) forceGc();
}
const streamElapsedMs = performance.now() - streamStarted;
forceGc();
peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
if (streamedRows !== STREAM_ROWS) {
  throw new Error(`Streamed ${streamedRows} rows instead of ${STREAM_ROWS}`);
}

const postgres = new PostgresConnector();
const missingPostgresCapabilities = ALL_DATABASE_CAPABILITIES.filter(
  (key) => !postgres.manifest.capabilities[key],
);
const metrics = {
  resourceIdLookupP95Ms: percentile(idLookupDurations, 0.95),
  singleHopRelationP95Ms: percentile(relationLookupDurations, 0.95),
  capabilityResolutionP95Ms: percentile(capabilityDurations, 0.95),
  querySubmissionP95Ms: percentile(submitDurations, 0.95),
  cancellationPropagationP95Ms: percentile(cancelDurations, 0.95),
  millionRowStreamMemoryDeltaMiB: (peakHeap - baselineHeap) / 1024 / 1024,
  millionRowStreamElapsedMs: streamElapsedMs,
  millionRowStreamBatches: batches,
  incrementalSingleResourceUpdateMs: incrementalMs,
  connectorCapabilityCoverage:
    (ALL_DATABASE_CAPABILITIES.length - missingPostgresCapabilities.length) /
    ALL_DATABASE_CAPABILITIES.length,
};
const thresholds = {
  resourceIdLookupP95Ms: 10,
  singleHopRelationP95Ms: 50,
  capabilityResolutionP95Ms: 5,
  querySubmissionP95Ms: 20,
  cancellationPropagationP95Ms: 100,
  millionRowStreamMemoryDeltaMiB: 64,
  connectorCapabilityCoverage: 1,
};
const assertions = Object.fromEntries(
  Object.entries(thresholds).map(([name, maximum]) => [
    name,
    {
      passed: metrics[name] <= maximum,
      actual: metrics[name],
      maximum,
    },
  ]),
);
const report = {
  generatedAt: new Date().toISOString(),
  dataset: {
    resources: RESOURCE_COUNT,
    relations: RESOURCE_COUNT,
    lookupSamples: LOOKUP_SAMPLES,
    jobSamples: JOB_SAMPLES,
    streamedRows,
  },
  metrics,
  thresholds,
  assertions,
  missingPostgresCapabilities,
  passed: Object.values(assertions).every((item) => item.passed),
};
await mkdir(join(root, 'reports'), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.passed) process.exitCode = 1;

function resource(id, kind, overrides = {}) {
  return {
    id,
    kind,
    nativeId: id,
    canonicalName: id,
    engine: 'benchmark',
    version: 1,
    firstSeenAt: timestamp,
    updatedAt: timestamp,
    sources: [source],
    ...overrides,
  };
}

function measureSync(samples, operation) {
  const durations = [];
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now();
    operation(index);
    durations.push(performance.now() - started);
  }
  return durations;
}

async function measureAsync(samples, operation) {
  const durations = [];
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now();
    await operation(index);
    durations.push(performance.now() - started);
  }
  return durations;
}

function percentile(values, quantile) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))];
}

function forceGc() {
  globalThis.gc?.();
}

function createBenchmarkConnector() {
  const jobs = new Map();
  const capabilities = Object.fromEntries(
    ALL_DATABASE_CAPABILITIES.map((key) => [
      key,
      {
        key,
        status: [
          DATABASE_CAPABILITIES.SQL_QUERY,
          DATABASE_CAPABILITIES.QUERY_CANCEL,
          DATABASE_CAPABILITIES.RESULT_STREAMING,
          DATABASE_CAPABILITIES.RESULT_PAGINATION,
        ].includes(key)
          ? 'supported'
          : 'unsupported',
        source: 'benchmark',
        observedAt: timestamp,
      },
    ]),
  );
  return {
    manifest: {
      id: 'benchmark-connector',
      displayName: 'Benchmark Connector',
      version: '1',
      engine: 'benchmark',
      transports: ['tcp'],
      execution: 'hybrid',
      capabilities,
      operations: [],
    },
    async test() {
      return {
        connectorId: 'benchmark-connector',
        engine: 'benchmark',
        status: 'healthy',
        checkedAt: timestamp,
      };
    },
    async connect(context) {
      return {
        id: 'benchmark-session',
        connectionId: 'benchmark-connection',
        profileId: context.profile.id,
        connectorId: 'benchmark-connector',
        status: 'connected',
        endpointIndex: 0,
        generation: 1,
      };
    },
    async disconnect() {},
    async health() {
      return { status: 'healthy', checkedAt: timestamp };
    },
    async capabilities(context) {
      return {
        connectorId: 'benchmark-connector',
        engine: 'benchmark',
        connectionProfileId: context.profile.id,
        resolvedAt: timestamp,
        capabilities,
      };
    },
    async discover() {
      return { resources: [], relations: [], complete: true };
    },
    async submit(context, submission) {
      const id = `job-${jobs.size + 1}`;
      const queued = submission.sql.includes('queued_benchmark_value');
      const stream = submission.sql === 'select * from benchmark_million_row_stream';
      const job = {
        id,
        profileId: context.profile.id,
        connectorId: 'benchmark-connector',
        state: queued ? 'queued' : 'succeeded',
        submittedAt: timestamp,
        ...(!queued ? { completedAt: timestamp } : {}),
        ...(stream
          ? {
              result: {
                id: 'million-row-result',
                jobId: id,
                format: 'rows',
                columns: [
                  { name: 'sequence', dataType: 'integer' },
                  { name: 'value', dataType: 'text' },
                ],
                rowCount: STREAM_ROWS,
              },
            }
          : {}),
      };
      jobs.set(id, job);
      return job;
    },
    async getJob(_context, jobId) {
      return jobs.get(jobId);
    },
    async cancel(_context, jobId) {
      const job = { ...jobs.get(jobId), state: 'cancelled', completedAt: timestamp };
      jobs.set(jobId, job);
      return job;
    },
    async readResult(_context, handleId) {
      return { handleId, rows: [], rowOffset: 0, complete: true };
    },
    async *streamResult(_context, handleId, input = {}) {
      const batchSize = input.batchSize ?? 1_000;
      for (let offset = 0; offset < STREAM_ROWS; offset += batchSize) {
        const length = Math.min(batchSize, STREAM_ROWS - offset);
        const rows = Array.from({ length }, (_, index) => ({
          sequence: offset + index,
          value: `value-${offset + index}`,
        }));
        const next = offset + length;
        yield {
          handleId,
          rows,
          rowOffset: offset,
          complete: next >= STREAM_ROWS,
          ...(next < STREAM_ROWS ? { nextCursor: String(next) } : {}),
        };
      }
    },
  };
}
