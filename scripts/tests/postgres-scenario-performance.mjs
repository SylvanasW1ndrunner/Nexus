import { mkdir, writeFile } from 'node:fs/promises';
import { cpus, platform, release } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(join(root, 'packages', 'core-db', 'package.json'));
const { Client } = require('pg');
const reportPath = join(root, 'reports', 'postgres-scenarios', 'performance.json');
const iterations = positiveInteger(process.env.DBAGENT_SCENARIO_PERF_ITERATIONS, 20);
const warmupIterations = positiveInteger(process.env.DBAGENT_SCENARIO_PERF_WARMUPS, 3);

const client = new Client({
  host: process.env.DBAGENT_TEST_PG_HOST ?? '127.0.0.1',
  port: Number(process.env.DBAGENT_TEST_PG_PORT ?? '5432'),
  database: process.env.DBAGENT_TEST_PG_DATABASE ?? 'dbagent_core_db_test',
  user: process.env.DBAGENT_TEST_PG_USER ?? 'postgres',
  password: process.env.DBAGENT_TEST_PG_PASSWORD ?? 'postgres',
  statement_timeout: positiveInteger(process.env.DBAGENT_SCENARIO_STATEMENT_TIMEOUT_MS, 15_000),
});

async function main() {
  await client.connect();
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
        thresholdMs: positiveNumber(process.env.DBAGENT_SCENARIO_ECOMMERCE_P95_MS, 250),
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
        thresholdMs: positiveNumber(process.env.DBAGENT_SCENARIO_TRAFFIC_P95_MS, 750),
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
        thresholdMs: positiveNumber(process.env.DBAGENT_SCENARIO_SCIENCE_P95_MS, 500),
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
        thresholdMs: positiveNumber(process.env.DBAGENT_SCENARIO_RESULT_PAGE_P95_MS, 1_000),
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
        warmupIterations,
        measuredIterations: iterations,
        thresholdsOverridableByEnvironment: true,
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
          p50Ms: scenario.p50Ms,
          p95Ms: scenario.p95Ms,
          maxMs: scenario.maxMs,
          thresholdMs: scenario.thresholdMs,
          passed: scenario.passed,
        })),
      })}`,
    );
    if (!report.passed) process.exitCode = 1;
  } finally {
    await client.end();
  }
}

async function benchmarkScenario({ name, sql, thresholdMs, validate }) {
  for (let index = 0; index < warmupIterations; index += 1) {
    validate(await client.query(sql));
  }
  const durations = [];
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    const result = await client.query(sql);
    durations.push(performance.now() - started);
    validate(result);
  }
  durations.sort((left, right) => left - right);
  const p50Ms = round(percentile(durations, 0.5));
  const p95Ms = round(percentile(durations, 0.95));
  const maxMs = round(durations.at(-1) ?? 0);
  return {
    name,
    warmupIterations,
    measuredIterations: durations.length,
    p50Ms,
    p95Ms,
    maxMs,
    thresholdMs,
    passed: p95Ms <= thresholdMs,
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
