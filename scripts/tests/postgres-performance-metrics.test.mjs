import assert from 'node:assert/strict';
import test from 'node:test';
import {
  averageDurableMeasurements,
  buildPostgresScenarioMetrics,
  readCompleteResultPages,
} from '../lib/postgres-performance-metrics.mjs';

test('averages mirrored durable measurements without losing phase or pagination evidence', () => {
  const averaged = averageDurableMeasurements(
    {
      durationMs: 100,
      result: { rowCount: 2_000, pageCount: 2, phases: { submit: 70, page: 25, release: 5 } },
    },
    {
      durationMs: 120,
      result: { rowCount: 2_000, pageCount: 2, phases: { submit: 80, page: 32, release: 8 } },
    },
  );

  assert.equal(averaged.durationMs, 110);
  assert.deepEqual(averaged.result.phases, { submit: 75, page: 28.5, release: 6.5 });
  assert.equal(averaged.result.rowCount, 2_000);
  assert.equal(averaged.result.pageCount, 2);
});

test('keeps absolute end-to-end latency while gating paired platform overhead', () => {
  const metrics = buildPostgresScenarioMetrics({
    directPgMs: [10, 11, 12, 13],
    durableReferenceMs: [40, 42, 44, 46],
    durableReferencePhasesMs: {
      submit: [28, 29, 30, 31],
      page: [8, 9, 10, 11],
      release: [4, 4, 4, 4],
    },
    schemanautEndToEndMs: [39, 48, 49, 52],
    exactPlatformOverheadMs: [2, 3, 4, 5],
    schemanautPhasesMs: {
      submit: [30, 31, 32, 33],
      page: [10, 11, 12, 13],
      release: [5, 6, 5, 6],
    },
    platformOverheadP95ThresholdMs: 7,
  });

  assert.equal(metrics.directPg.p95Ms, 13);
  assert.equal(metrics.durableReference.p95Ms, 46);
  assert.equal(metrics.schemanaut.p95Ms, 52);
  assert.deepEqual(metrics.platformOverhead.rawSamplesMs, [2, 3, 4, 5]);
  assert.equal(metrics.platformOverhead.p95Ms, 5);
  assert.equal(metrics.platformOverheadP95Ms, 5);
  assert.deepEqual(metrics.durableReferenceDelta.rawSamplesMs, [-1, 6, 5, 6]);
  assert.equal(metrics.durabilityOverhead.p95Ms, 33);
  assert.equal(metrics.phases.submit.p95Ms, 33);
  assert.equal(metrics.durableReferencePhases.submit.p95Ms, 31);
  assert.equal(metrics.passed, true);
});

test('reads a complete durable result through the public 1000-row cursor contract', async () => {
  const source = Array.from({ length: 2_000 }, (_, index) => ({ observation_id: index + 1 }));
  const requestedLimits = [];
  const page = await readCompleteResultPages({
    handleId: 'result-large',
    pageLimit: 1_000,
    readPage: ({ cursor, limit }) => {
      requestedLimits.push(limit);
      const offset = cursor === undefined ? 0 : Number(cursor);
      const rows = source.slice(offset, offset + limit);
      const nextOffset = offset + rows.length;
      return Promise.resolve({
        handleId: 'result-large',
        rows,
        rowOffset: offset,
        complete: nextOffset >= source.length,
        byteCount: Buffer.byteLength(JSON.stringify(rows)),
        ...(nextOffset >= source.length ? {} : { nextCursor: String(nextOffset) }),
      });
    },
  });

  assert.deepEqual(requestedLimits, [1_000, 1_000]);
  assert.equal(page.pageCount, 2);
  assert.equal(page.rowCount, 2_000);
  assert.equal(page.rows[0].observation_id, 1);
  assert.equal(page.rows.at(-1).observation_id, 2_000);
});

test('rejects an incomplete page that cannot advance its cursor', async () => {
  await assert.rejects(
    () => readCompleteResultPages({
      handleId: 'result-stuck',
      readPage: () => Promise.resolve({
        handleId: 'result-stuck', rows: [{ value: 1 }], rowOffset: 0,
        complete: false, byteCount: 10,
      }),
    }),
    /next cursor/,
  );
});
