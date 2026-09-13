#!/usr/bin/env node

import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { cpus, platform, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  assertConnectionProfile,
  assertContractEnvelope,
  assertDatabaseAccessError,
  assertQuerySubmission,
  assertResourceDescriptor,
  assertResourceRegistrySnapshot,
  stringifyPublicJson,
} from '../packages/shared/dist/index.js';

const root = resolve(import.meta.dirname, '..');
const reportPath = join(root, 'reports', 'public-contracts', 'performance.json');
const fixtureDirectory = join(root, 'packages', 'shared', 'test', 'fixtures', 'v1');
const SAMPLES = 10_000;
const MIXED_RESULT_SAMPLES = 1_000;
const time = '2026-07-23T00:00:00.000Z';
const source = {
  sourceId: 'contract-benchmark',
  sourceType: 'connector',
  observedAt: time,
};
const resource = {
  id: 'resource-contract-benchmark',
  kind: 'table',
  nativeId: 'analytics.public.orders',
  canonicalName: 'analytics.public.orders',
  displayName: 'Orders',
  aliases: ['sales_orders'],
  engine: 'postgres',
  scope: {
    tenantId: 'benchmark',
    projectId: 'analytics',
    environment: 'test',
  },
  tags: { owner: 'data-platform' },
  attributes: {
    estimatedRows: 1_000_000,
    partitioned: true,
    description: 'Contract benchmark resource',
  },
  version: 1,
  firstSeenAt: time,
  updatedAt: time,
  sources: [source],
};
const query = {
  profileId: 'profile-contract-benchmark',
  sql: 'select * from analytics.public.orders where id = $1 and created_at >= $2',
  params: [9_007_199_254_740_993n, new Date(time), Uint8Array.from([0, 1, 254, 255])],
  timeoutMs: 5_000,
  rowLimit: 1_000,
  batchSize: 250,
  authorization: {
    actorId: 'benchmark-user',
    authorizedClass: 'query',
  },
  labels: { workload: 'contract-benchmark' },
};
const ordinaryObject = {
  requestId: 'request-1',
  ok: true,
  count: 42,
  nested: {
    strings: ['one', 'two', 'three'],
    values: { a: 1, b: 2, c: 3 },
  },
};
const mixedRows = Array.from({ length: 1_000 }, (_, index) => ({
  id: BigInt(Number.MAX_SAFE_INTEGER) + BigInt(index + 1),
  createdAt: new Date(time),
  payload: Uint8Array.from([index % 256, (index + 1) % 256]),
  amount: index + 0.25,
  active: index % 2 === 0,
  label: `row-${index}`,
}));

const resourceValidation = measure(SAMPLES, () => assertResourceDescriptor(resource));
const queryValidation = measure(SAMPLES, () => assertQuerySubmission(query));
const ordinaryEncoding = measure(SAMPLES, () => stringifyPublicJson(ordinaryObject));
const mixedEncoding = measure(MIXED_RESULT_SAMPLES, () =>
  stringifyPublicJson({ rows: mixedRows, complete: true }),
);

const tenMegabytePayload = {
  content: 'x'.repeat(10 * 1024 * 1024),
};
const largeStartedAt = performance.now();
const encodedLargePayload = stringifyPublicJson(tenMegabytePayload);
const largePayloadEncodingMs = performance.now() - largeStartedAt;
if (Buffer.byteLength(encodedLargePayload, 'utf8') < 10 * 1024 * 1024) {
  throw new Error('The 10 MB benchmark payload was not encoded completely');
}

const fixtureChecks = await validateFixtures();
const metrics = {
  resourceValidationP95Ms: percentile(resourceValidation, 0.95),
  queryValidationP95Ms: percentile(queryValidation, 0.95),
  ordinaryEncodingP95Ms: percentile(ordinaryEncoding, 0.95),
  mixedThousandRowEncodingP95Ms: percentile(mixedEncoding, 0.95),
  tenMegabyteEncodingMs: largePayloadEncodingMs,
  fixtureCompatibilityRate:
    fixtureChecks.length === 0
      ? 0
      : fixtureChecks.filter((item) => item.passed).length / fixtureChecks.length,
};
const thresholds = {
  resourceValidationP95Ms: 1,
  queryValidationP95Ms: 1,
  ordinaryEncodingP95Ms: 1,
  mixedThousandRowEncodingP95Ms: 10,
  tenMegabyteEncodingMs: 250,
  fixtureCompatibilityRate: 1,
};
const checks = Object.fromEntries(
  Object.entries(thresholds).map(([name, target]) => {
    const minimum = name === 'fixtureCompatibilityRate';
    return [
      name,
      {
        actual: metrics[name],
        ...(minimum ? { minimum: target } : { maximum: target }),
        passed: minimum ? metrics[name] >= target : metrics[name] <= target,
      },
    ];
  }),
);
const report = {
  kind: 'public-contracts-performance',
  status: Object.values(checks).every((check) => check.passed) ? 'passed' : 'failed',
  generatedAt: new Date().toISOString(),
  environment: environment(),
  dataset: {
    contractValidationSamples: SAMPLES,
    ordinaryEncodingSamples: SAMPLES,
    mixedResultRows: mixedRows.length,
    mixedResultSamples: MIXED_RESULT_SAMPLES,
    largePayloadBytes: Buffer.byteLength(encodedLargePayload, 'utf8'),
    fixtures: fixtureChecks.length,
  },
  thresholds,
  metrics,
  checks,
  fixtureChecks,
  measurement:
    'In-process public contract validation and transport encoding; business runtime, database and network time excluded.',
};

await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify(report, null, 2)}\nReport: ${reportPath}\n`);
if (report.status !== 'passed') process.exitCode = 1;

function measure(samples, operation) {
  for (let index = 0; index < 200; index += 1) operation(index);
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
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)];
}

async function validateFixtures() {
  const fixtureContracts = {
    'resource-snapshot.json': {
      contract: 'schemanaut.resource-registry.snapshot',
      validate: assertResourceRegistrySnapshot,
    },
    'connection-profile.json': {
      contract: 'schemanaut.database.connection-profile',
      validate: assertConnectionProfile,
    },
    'query-submission.json': {
      contract: 'schemanaut.database.query-submission',
      validate: assertQuerySubmission,
    },
    'database-error.json': {
      contract: 'schemanaut.database.error',
      validate: assertDatabaseAccessError,
    },
  };
  const names = (await readdir(fixtureDirectory)).filter((name) => name.endsWith('.json')).sort();
  const checks = [];
  for (const name of names) {
    const envelope = JSON.parse(await readFile(join(fixtureDirectory, name), 'utf8'));
    try {
      const fixture = fixtureContracts[name];
      if (!fixture) {
        throw new Error(`No compatibility validator is registered for ${name}`);
      }
      assertContractEnvelope(envelope, fixture.contract);
      fixture.validate(envelope.payload);
      checks.push({ fixture: name, passed: true });
    } catch (error) {
      checks.push({
        fixture: name,
        passed: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return checks;
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
