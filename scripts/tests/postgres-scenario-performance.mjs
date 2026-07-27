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
connectors.register(new PostgresConnector());
const runtime = new DatabaseAccessRuntime({
  connectors,
  maxAuditEvents: iterations * 16,
});
const profileId = `postgres-scenario-performance-${process.pid}`;
const timestamp = new Date().toISOString();
runtime.createProfile({
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
});

async function main() {
  await client.connect();
  await runtime.connect(profileId, {
    username: databaseConfig.user,
    password: databaseConfig.password,
  });
  try {
    const postgresVersion = (
      await client.query("select current_setting('server_version') as server_version")
    ).rows[0].server_version;
    const scale = await readScale();
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

    scenarios.push(
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
    scenarios.push(
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
    scenarios.push(
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
    scenarios.push(
      await benchmarkScenario({
        name: 'big-science-result-page',
        sql: SCIENCE_RESULT_PAGE_QUERY,
        validate(result) {
          assert(result.rowCount === 2_000, '大结果页必须返回 2000 行');
        },
      }),
    );

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
        comparedPaths: ['pg.Client.query', 'DatabaseAccessRuntime + PostgresConnector'],
        gate: 'SchemaNaut P95 minus direct pg P95',
        platformOverheadP95ThresholdMs: overheadThresholdMs,
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
          schemanautP95Ms: scenario.schemanaut.p95Ms,
          platformOverheadP95Ms: scenario.platformOverheadP95Ms,
          thresholdMs: scenario.platformOverheadP95ThresholdMs,
          passed: scenario.passed,
        })),
      })}`,
    );
    if (!report.passed) process.exitCode = 1;
  } finally {
    await runtime.disconnect(profileId).catch(() => undefined);
    await client.end();
  }
}

async function benchmarkScenario({ name, sql, validate }) {
  const warmupStarted = performance.now();
  let warmupIterations = 0;
  while (performance.now() - warmupStarted < warmupDurationMs) {
    if (warmupIterations % 2 === 0) {
      validate(await runDirect(sql));
      validate(await runThroughSchemaNaut(sql));
    } else {
      validate(await runThroughSchemaNaut(sql));
      validate(await runDirect(sql));
    }
    warmupIterations += 1;
  }

  const directPgSamplesMs = [];
  const schemanautSamplesMs = [];
  const pairedOverheadSamplesMs = [];
  for (let index = 0; index < iterations; index += 1) {
    const directFirst = index % 2 === 0;
    const first = directFirst
      ? await measure(() => runDirect(sql))
      : await measure(() => runThroughSchemaNaut(sql));
    const second = directFirst
      ? await measure(() => runThroughSchemaNaut(sql))
      : await measure(() => runDirect(sql));
    const direct = directFirst ? first : second;
    const schemanaut = directFirst ? second : first;
    validate(direct.result);
    validate(schemanaut.result);
    directPgSamplesMs.push(round(direct.durationMs));
    schemanautSamplesMs.push(round(schemanaut.durationMs));
    pairedOverheadSamplesMs.push(round(schemanaut.durationMs - direct.durationMs));
  }

  const directPg = summarize(directPgSamplesMs);
  const schemanaut = summarize(schemanautSamplesMs);
  const platformOverheadP95Ms = round(schemanaut.p95Ms - directPg.p95Ms);
  return {
    name,
    warmupIterations,
    warmupElapsedMs: round(performance.now() - warmupStarted),
    measuredIterations: iterations,
    directPg,
    schemanaut,
    platformOverheadP95Ms,
    pairedOverhead: summarize(pairedOverheadSamplesMs),
    platformOverheadP95ThresholdMs: overheadThresholdMs,
    rawSamples: {
      directPgMs: directPgSamplesMs,
      schemanautMs: schemanautSamplesMs,
      pairedOverheadMs: pairedOverheadSamplesMs,
    },
    passed: platformOverheadP95Ms <= overheadThresholdMs,
  };
}

async function runDirect(sql) {
  const result = await client.query(sql);
  return {
    rowCount: result.rowCount ?? result.rows.length,
    rows: result.rows,
  };
}

async function runThroughSchemaNaut(sql) {
  const job = await runtime.submit({
    profileId,
    sql,
    executionMode: 'sync',
    rowLimit: 10_000,
    authorization: { permissionMode: 'read' },
  });
  assert(job.state === 'succeeded' && job.result, `SchemaNaut query failed for ${profileId}`);
  const batch = await runtime.readResult(job.result.id, { limit: 10_000 });
  assert(batch.complete, 'SchemaNaut benchmark result did not fit in one 10000-row page');
  return {
    rowCount: job.result.rowCount ?? batch.rows.length,
    rows: batch.rows,
  };
}

async function measure(operation) {
  const started = performance.now();
  const result = await operation();
  return { durationMs: performance.now() - started, result };
}

function summarize(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    p50Ms: round(percentile(sorted, 0.5)),
    p95Ms: round(percentile(sorted, 0.95)),
    maxMs: round(sorted.at(-1) ?? 0),
    minMs: round(sorted[0] ?? 0),
  };
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

function percentile(values, ratio) {
  if (values.length === 0) return 0;
  const rank = Math.max(0, Math.ceil(values.length * ratio) - 1);
  return values[Math.min(rank, values.length - 1)];
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
