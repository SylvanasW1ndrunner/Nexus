import { mkdir, writeFile } from 'node:fs/promises';
import { cpus, platform, release } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  ConnectorRegistry,
  DatabaseAccessRuntime,
  PostgresConnector,
} from '../../packages/core-db/dist/index.js';
import {
  averageDurableMeasurements,
  buildPostgresScenarioMetrics,
  readCompleteResultPages,
} from '../lib/postgres-performance-metrics.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(join(root, 'packages', 'core-db', 'package.json'));
const { Client } = require('pg');
const reportPath = join(root, 'reports', 'postgres-scenarios', 'performance.json');
const iterations = Math.max(
  40,
  positiveInteger(process.env.DBAGENT_SCENARIO_PERF_ITERATIONS, 40),
);
const warmupDurationMs = Math.max(
  10_000,
  positiveInteger(process.env.DBAGENT_SCENARIO_PERF_WARMUP_MS, 10_000),
);
const overheadThresholdMs = positiveNumber(
  process.env.DBAGENT_SCENARIO_PLATFORM_OVERHEAD_P95_MS,
  50,
);
const scenarioFilter = new Set(
  (process.env.DBAGENT_SCENARIO_PERF_FILTER ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
);
const knownScenarioNames = new Set([
  'ecommerce-finance',
  'traffic-cleaning-anomaly',
  'big-science-statistics',
  'big-science-result-page',
]);
const databaseConfig = {
  host: process.env.DBAGENT_TEST_PG_HOST ?? '127.0.0.1',
  port: Number(process.env.DBAGENT_TEST_PG_PORT ?? '5432'),
  database: process.env.DBAGENT_TEST_PG_DATABASE ?? 'dbagent_core_db_test',
  user: process.env.DBAGENT_TEST_PG_USER ?? 'postgres',
  password: process.env.DBAGENT_TEST_PG_PASSWORD ?? 'postgres',
};

const client = new Client({
  ...databaseConfig,
  statement_timeout: positiveInteger(process.env.DBAGENT_SCENARIO_STATEMENT_TIMEOUT_MS, 15_000),
});
const connectors = new ConnectorRegistry();
let activeRuntimeConnectorTimings;
connectors.register(instrumentRuntimeConnector(new PostgresConnector()));
const durableReferenceConnector = new PostgresConnector();
const runtime = new DatabaseAccessRuntime({
  connectors,
  maxAuditEvents: iterations * 16,
});
const profileId = `postgres-scenario-performance-${process.pid}`;
const durableReferenceProfileId = `postgres-scenario-durable-reference-${process.pid}`;
const timestamp = new Date().toISOString();
const profile = {
  id: profileId,
  name: 'PostgreSQL scenario performance',
  connectorId: 'postgres-native',
  engine: 'postgres',
  endpoints: [
    {
      transport: 'tcp',
      host: databaseConfig.host,
      port: databaseConfig.port,
      database: databaseConfig.database,
    },
  ],
  principal: databaseConfig.user,
  purpose: 'query',
  readOnly: true,
  network: {
    connectTimeoutMs: 5_000,
    statementTimeoutMs: positiveInteger(
      process.env.DBAGENT_SCENARIO_STATEMENT_TIMEOUT_MS,
      15_000,
    ),
  },
  pool: { min: 1, max: 2 },
  createdAt: timestamp,
  updatedAt: timestamp,
};
const durableReferenceProfile = {
  ...profile,
  id: durableReferenceProfileId,
  name: 'PostgreSQL durable connector reference',
};
const durableReferenceContext = {
  profile: durableReferenceProfile,
  credential: { username: databaseConfig.user, password: databaseConfig.password },
};
runtime.createProfile(profile);

async function main() {
  await client.connect();
  await runtime.connect(profileId, {
    username: databaseConfig.user,
    password: databaseConfig.password,
  });
  await durableReferenceConnector.connect(durableReferenceContext);
  try {
    const postgresVersion = (
      await client.query("select current_setting('server_version') as server_version")
    ).rows[0].server_version;
    const scale = await readScale();
    for (const name of scenarioFilter) {
      assert(knownScenarioNames.has(name), `Unknown performance scenario filter: ${name}`);
    }
    assert(
      scale.ecommerce_orders >= 20_000,
      `电商性能 Fixture 至少需要 20000 个订单，实际为 ${scale.ecommerce_orders}`,
    );
    assert(
      scale.raw_events >= 20_000,
      `流量性能 Fixture 至少需要 20000 条原始事件，实际为 ${scale.raw_events}`,
    );
    assert(
      scale.science_observations >= 24_000,
      `大科学性能 Fixture 至少需要 24000 条观测，实际为 ${scale.science_observations}`,
    );
    const scenarios = [];

    if (shouldRunScenario('ecommerce-finance')) scenarios.push(
      await benchmarkScenario({
        name: 'ecommerce-finance',
        sql: ECOMMERCE_QUERY,
        validate(result) {
          assert(result.rowCount === 12, '电商聚合必须返回 12 个 本地月份×渠道 分组');
          const total = result.rows.reduce((sum, row) => sum + Number(row.net_revenue), 0);
          assert(total === 21780, `电商净收入总计应为 21780，实际为 ${total}`);
        },
      }),
    );
    if (shouldRunScenario('traffic-cleaning-anomaly')) scenarios.push(
      await benchmarkScenario({
        name: 'traffic-cleaning-anomaly',
        sql: TRAFFIC_QUERY,
        validate(result) {
          assert(result.rowCount === 203, '流量清洗必须返回 203 个分钟桶');
          const eventCount = result.rows.reduce((sum, row) => sum + Number(row.event_count), 0);
          assert(eventCount === 20011, `去重清洗后应有 20011 条事件，实际为 ${eventCount}`);
          assert(
            result.rows.filter((row) => row.volume_anomaly).length === 201,
            '必须识别出 201 个流量异常分钟桶',
          );
        },
      }),
    );
    if (shouldRunScenario('big-science-statistics')) scenarios.push(
      await benchmarkScenario({
        name: 'big-science-statistics',
        sql: SCIENCE_QUERY,
        validate(result) {
          assert(result.rowCount === 2, '大科学统计必须返回 2 个实验');
          const observations = result.rows.reduce(
            (sum, row) => sum + Number(row.observation_count),
            0,
          );
          assert(observations === 24_000, `科学观测总数应为 24000，实际为 ${observations}`);
        },
      }),
    );
    if (shouldRunScenario('big-science-result-page')) scenarios.push(
      await benchmarkScenario({
        name: 'big-science-result-page',
        sql: SCIENCE_RESULT_PAGE_QUERY,
        validate(result) {
          assert(result.rowCount === 2_000, '大结果页必须返回 2000 行');
          if (result.pageCount !== undefined) {
            assert(result.pageCount === 2, '大结果必须按 1000 行公共分页合同读取 2 页');
          }
        },
      }),
    );
    assert(scenarios.length > 0, 'The performance scenario filter selected no scenarios.');

    const report = {
      generatedAt: new Date().toISOString(),
      runId: process.env.DBAGENT_TEST_RUN_ID ?? 'standalone',
      environment: {
        node: process.version,
        os: `${platform()} ${release()}`,
        cpu: cpus()[0]?.model ?? 'unknown',
        postgres: postgresVersion,
      },
      configuration: {
        warmupDurationMs,
        measuredIterations: iterations,
        comparedPaths: [
          'pg.Client.query',
          'PostgresConnector durable submit + complete cursor paging + release',
          'DatabaseAccessRuntime + PostgresConnector end-to-end',
        ],
        gate: 'paired outer DatabaseAccessRuntime time minus the same in-call connector boundary P95',
        pairing: 'mirrored ABBA durable runs; exact platform timing brackets each runtime connector call',
        platformOverheadP95ThresholdMs: overheadThresholdMs,
        scenarioFilter: [...scenarioFilter],
      },
      scale,
      scenarios,
      passed: scenarios.every((scenario) => scenario.passed),
    };

    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.info(
      `[postgres-scenarios] ${JSON.stringify({
        report: reportPath,
        passed: report.passed,
        scenarios: scenarios.map((scenario) => ({
          name: scenario.name,
          directPgP95Ms: scenario.directPg.p95Ms,
          durableReferenceP95Ms: scenario.durableReference.p95Ms,
          schemanautP95Ms: scenario.schemanaut.p95Ms,
          platformOverheadP95Ms: scenario.platformOverheadP95Ms,
          thresholdMs: scenario.platformOverheadP95ThresholdMs,
          passed: scenario.passed,
        })),
      })}`,
    );
    if (!report.passed) process.exitCode = 1;
  } finally {
    await durableReferenceConnector.disconnect(durableReferenceContext).catch(() => undefined);
    await runtime.disconnect(profileId).catch(() => undefined);
    await client.end();
  }
}

async function benchmarkScenario({ name, sql, validate }) {
  const warmupStarted = performance.now();
  let warmupIterations = 0;
  while (performance.now() - warmupStarted < warmupDurationMs) {
    for (const path of rotatedPaths(warmupIterations)) {
      validate(await runPath(path, sql));
    }
    warmupIterations += 1;
  }

  const directPgSamplesMs = [];
  const durableReferenceSamplesMs = [];
  const schemanautSamplesMs = [];
  const exactPlatformOverheadSamplesMs = [];
  const schemanautPhasesMs = { submit: [], page: [], release: [] };
  const durableReferencePhasesMs = { submit: [], page: [], release: [] };
  const paginationSamples = { durableReference: [], schemanaut: [] };
  for (let index = 0; index < iterations; index += 1) {
    const direct = await measure(() => runDirect(sql));
    const order = index % 2 === 0
      ? ['durableReference', 'schemanaut', 'schemanaut', 'durableReference']
      : ['schemanaut', 'durableReference', 'durableReference', 'schemanaut'];
    const mirrored = [];
    for (const path of order) mirrored.push(await measure(() => runPath(path, sql)));
    const durableReference = averageDurableMeasurements(
      mirrored[order.indexOf('durableReference')],
      mirrored[order.lastIndexOf('durableReference')],
    );
    const schemanaut = averageDurableMeasurements(
      mirrored[order.indexOf('schemanaut')],
      mirrored[order.lastIndexOf('schemanaut')],
    );
    validate(direct.result);
    for (const measurement of mirrored) validate(measurement.result);
    directPgSamplesMs.push(round(direct.durationMs));
    durableReferenceSamplesMs.push(round(durableReference.durationMs));
    schemanautSamplesMs.push(round(schemanaut.durationMs));
    const firstSchemaNaut = mirrored[order.indexOf('schemanaut')].result;
    const secondSchemaNaut = mirrored[order.lastIndexOf('schemanaut')].result;
    exactPlatformOverheadSamplesMs.push(round(
      (firstSchemaNaut.exactPlatformOverheadMs + secondSchemaNaut.exactPlatformOverheadMs) / 2,
    ));
    recordPhases(durableReferencePhasesMs, durableReference.result.phases);
    recordPhases(schemanautPhasesMs, schemanaut.result.phases);
    paginationSamples.durableReference.push(durableReference.result.pageCount);
    paginationSamples.schemanaut.push(schemanaut.result.pageCount);
  }

  return {
    name,
    warmupIterations,
    warmupElapsedMs: round(performance.now() - warmupStarted),
    measuredIterations: iterations,
    ...buildPostgresScenarioMetrics({
      directPgMs: directPgSamplesMs,
      durableReferenceMs: durableReferenceSamplesMs,
      schemanautEndToEndMs: schemanautSamplesMs,
      exactPlatformOverheadMs: exactPlatformOverheadSamplesMs,
      durableReferencePhasesMs,
      schemanautPhasesMs,
      platformOverheadP95ThresholdMs: overheadThresholdMs,
    }),
    pagination: {
      publicPageLimit: 1_000,
      rawPageCounts: paginationSamples,
    },
  };
}

function rotatedPaths(index) {
  const paths = ['direct', 'durableReference', 'schemanaut'];
  const offset = index % paths.length;
  return [...paths.slice(offset), ...paths.slice(0, offset)];
}

function runPath(path, sql) {
  if (path === 'direct') return runDirect(sql);
  if (path === 'durableReference') return runThroughDurableReference(sql);
  return runThroughSchemaNaut(sql);
}

async function runDirect(sql) {
  const result = await client.query(sql);
  return {
    rowCount: result.rowCount ?? result.rows.length,
    rows: result.rows,
  };
}

async function runThroughSchemaNaut(sql) {
  const connectorPhases = { submit: 0, page: 0, release: 0 };
  activeRuntimeConnectorTimings = connectorPhases;
  try {
    const result = await runDurablePath(
      () => runtime.submit({
        profileId,
        sql,
        executionMode: 'sync',
        rowLimit: 10_000,
        authorization: { authorizedClass: 'query' },
      }),
      (handleId, request) => runtime.readResult(handleId, request),
      (handleId) => runtime.releaseResult(handleId),
      profileId,
    );
    result.exactPlatformOverheadMs = round(
      result.phases.submit + result.phases.page + result.phases.release -
      connectorPhases.submit - connectorPhases.page - connectorPhases.release,
    );
    return result;
  } finally {
    activeRuntimeConnectorTimings = undefined;
  }
}

async function runThroughDurableReference(sql) {
  return runDurablePath(
    () => durableReferenceConnector.submit(durableReferenceContext, {
      profileId: durableReferenceProfileId,
      sql,
      executionMode: 'sync',
      rowLimit: 10_000,
      authorization: { authorizedClass: 'query' },
    }),
    (handleId, request) => durableReferenceConnector.readResult(
      durableReferenceContext,
      handleId,
      request,
    ),
    (handleId) => durableReferenceConnector.releaseResult(durableReferenceContext, handleId),
    durableReferenceProfileId,
  );
}

async function runDurablePath(submit, readPage, release, identity) {
  const submitted = await measure(submit);
  const job = submitted.result;
  assert(job.state === 'succeeded' && job.result, `Durable query failed for ${identity}`);
  let paged;
  let released;
  try {
    paged = await measure(() => readCompleteResultPages({
      handleId: job.result.id,
      pageLimit: 1_000,
      readPage: (request) => readPage(job.result.id, request),
    }));
  } finally {
    released = await measure(() => release(job.result.id));
  }
  return {
    rowCount: job.result.rowCount ?? paged.result.rowCount,
    rows: paged.result.rows,
    pageCount: paged.result.pageCount,
    phases: {
      submit: round(submitted.durationMs),
      page: round(paged.durationMs),
      release: round(released.durationMs),
    },
  };
}

function recordPhases(target, phases) {
  for (const name of Object.keys(target)) target[name].push(phases[name]);
}

function instrumentRuntimeConnector(connector) {
  const phaseByMethod = { submit: 'submit', readResult: 'page', releaseResult: 'release' };
  return new Proxy(connector, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      const phase = phaseByMethod[property];
      if (!phase) return value.bind(target);
      return async (...args) => {
        const started = performance.now();
        try {
          return await value.apply(target, args);
        } finally {
          if (activeRuntimeConnectorTimings) {
            activeRuntimeConnectorTimings[phase] += performance.now() - started;
          }
        }
      };
    },
  });
}

async function measure(operation) {
  const started = performance.now();
  const result = await operation();
  return { durationMs: performance.now() - started, result };
}

async function readScale() {
  const result = await client.query(`
    select
      (select count(*)::integer from commerce.orders) as ecommerce_orders,
      (select count(*)::integer from commerce.order_items) as ecommerce_items,
      (select count(*)::integer from traffic_lab.raw_kafka_events) as raw_events,
      (select count(*)::integer from science.observations) as science_observations,
      (
        select count(*)::integer
        from pg_inherits
        where inhparent = 'science.observations'::regclass
      ) as science_partitions
  `);
  return result.rows[0];
}

function round(value) {
  return Number(value.toFixed(3));
}

function positiveInteger(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveNumber(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function shouldRunScenario(name) {
  return scenarioFilter.size === 0 || scenarioFilter.has(name);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const ECOMMERCE_QUERY = `
  with settled_payments as (
    select order_id, sum(paid_amount)::numeric(14, 2) as paid_amount
    from commerce.payments
    where status = 'settled'
    group by order_id
  ),
  successful_refunds as (
    select p.order_id, sum(r.refund_amount)::numeric(14, 2) as refund_amount
    from commerce.refunds r
    join commerce.payments p on p.payment_id = r.payment_id
    where r.status = 'succeeded'
    group by p.order_id
  )
  select
    date_trunc('month', o.created_at at time zone 'Asia/Shanghai')::date as month,
    o.channel,
    count(distinct o.customer_id)::bigint as customer_count,
    sum(sp.paid_amount - coalesce(sr.refund_amount, 0))::numeric(14, 2)
      as net_revenue
  from commerce.orders o
  join settled_payments sp on sp.order_id = o.order_id
  left join successful_refunds sr on sr.order_id = o.order_id
  group by 1, 2
  order by 1, 2
`;

const TRAFFIC_QUERY = `
  with extracted as materialized (
    select
      nullif(value ->> 'event_id', '') as event_id,
      nullif(value ->> 'visitor_id', '') as visitor_id,
      value ->> 'event_type' as event_type,
      case
        when value ->> 'event_time'
          ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'
        then (value ->> 'event_time')::timestamptz
      end as event_time,
      case
        when value ->> 'ingested_at'
          ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'
        then (value ->> 'ingested_at')::timestamptz
      end as ingested_at,
      case
        when value ->> 'latency_ms' ~ '^[0-9]+([.][0-9]+)?$'
        then (value ->> 'latency_ms')::numeric
      end as latency_ms
    from traffic_lab.raw_kafka_events
  ),
  validated as (
    select
      e.event_id,
      e.event_time,
      e.ingested_at,
      e.latency_ms,
      row_number() over (
        partition by e.event_id
        order by e.ingested_at desc nulls last
      ) as duplicate_rank
    from extracted e
    join traffic_lab.event_type_dictionary d
      on d.event_type = e.event_type
     and d.active
    where e.event_id is not null
      and e.visitor_id is not null
      and e.event_time is not null
      and e.ingested_at is not null
      and e.latency_ms is not null
  ),
  deduplicated as (
    select event_time, latency_ms
    from validated
    where duplicate_rank = 1
  )
  select
    date_trunc('minute', event_time) as minute,
    count(*)::bigint as event_count,
    round(avg(latency_ms), 2) as avg_latency_ms,
    count(*) filter (
      where latency_ms > (
        select threshold
        from traffic_lab.anomaly_thresholds
        where metric_name = 'latency_ms'
      )
    )::bigint as high_latency_events,
    count(*) > (
      select threshold
      from traffic_lab.anomaly_thresholds
      where metric_name = 'events_per_minute'
    ) as volume_anomaly
  from deduplicated
  group by 1
  order by 1
`;

const SCIENCE_QUERY = `
  with calibrated as (
    select
      e.experiment_code,
      s.sample_code,
      (o.signal - o.background)::numeric(24, 8) as net_signal
    from science.observations o
    join science.experiments e on e.experiment_id = o.experiment_id
    join science.samples s on s.sample_id = o.sample_id
    where o.observed_at >= '2026-01-01 00:00:00+00'
      and o.observed_at < '2026-03-01 00:00:00+00'
  ),
  sample_statistics as (
    select
      experiment_code,
      sample_code,
      count(*)::bigint as observation_count,
      avg(net_signal) as mean_net_signal,
      stddev_samp(net_signal) as stddev_net_signal
    from calibrated
    group by experiment_code, sample_code
  )
  select
    experiment_code,
    count(*)::bigint as sample_count,
    sum(observation_count)::bigint as observation_count,
    round(avg(mean_net_signal), 6) as mean_of_sample_means,
    round(max(stddev_net_signal), 6) as max_sample_stddev
  from sample_statistics
  group by experiment_code
  order by experiment_code
`;

const SCIENCE_RESULT_PAGE_QUERY = `
  select
    observation_id,
    experiment_id,
    sample_id,
    instrument_id,
    observed_at,
    signal,
    background,
    quality_flags,
    metadata
  from science.observations
  order by observed_at, observation_id
  limit 2000
`;

await main();
