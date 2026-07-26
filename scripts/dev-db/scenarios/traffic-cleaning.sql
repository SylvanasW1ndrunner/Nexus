begin;

create schema traffic_lab;

create table traffic_lab.event_type_dictionary (
  event_type text primary key,
  description text not null,
  active boolean not null default true
);

create table traffic_lab.anomaly_thresholds (
  metric_name text primary key,
  threshold numeric(18, 4) not null check (threshold > 0),
  unit text not null
);

-- 该表故意只有 value 一列，用于模拟未解包的 Kafka JSON 消息。
create table traffic_lab.raw_kafka_events (
  value jsonb not null check (jsonb_typeof(value) = 'object')
);

comment on schema traffic_lab is '流量事件清洗和异常检测验收场景';
comment on table traffic_lab.raw_kafka_events is
  'Kafka 原始消息；业务字段、事件时间、枚举和摄取时间全部位于 value JSONB';
comment on column traffic_lab.raw_kafka_events.value is
  '常用路径：event_id、event_time、ingested_at、event_type、visitor_id、latency_ms、page、source';

create index idx_traffic_raw_event_id
  on traffic_lab.raw_kafka_events ((value ->> 'event_id'));
create index idx_traffic_raw_event_time
  on traffic_lab.raw_kafka_events ((value ->> 'event_time'));
create index idx_traffic_raw_value_gin
  on traffic_lab.raw_kafka_events using gin(value);

insert into traffic_lab.event_type_dictionary (
  event_type,
  description
) values
  ('page_view', '页面浏览'),
  ('click', '点击'),
  ('purchase', '购买'),
  ('heartbeat', '客户端心跳');

insert into traffic_lab.anomaly_thresholds (
  metric_name,
  threshold,
  unit
) values
  ('latency_ms', 500, 'ms'),
  ('events_per_minute', 4, 'events');

insert into traffic_lab.raw_kafka_events(value) values
  ('{"event_id":"e-001","event_time":"2026-03-01T10:00:05Z","ingested_at":"2026-03-01T10:00:06Z","event_type":"page_view","visitor_id":"u-001","latency_ms":120,"page":"/home","source":"web"}'),
  ('{"event_id":"e-002","event_time":"2026-03-01T10:00:15Z","ingested_at":"2026-03-01T10:00:16Z","event_type":"page_view","visitor_id":"u-002","latency_ms":110,"page":"/product/1","source":"app"}'),
  ('{"event_id":"e-002","event_time":"2026-03-01T10:00:15Z","ingested_at":"2026-03-01T10:00:17Z","event_type":"page_view","visitor_id":"u-002","latency_ms":110,"page":"/product/1","source":"app"}'),
  ('{"event_id":"e-003","event_time":"2026-03-01T10:00:25Z","ingested_at":"2026-03-01T10:00:26Z","event_type":"purchase","visitor_id":"u-003","latency_ms":900,"page":"/checkout","source":"web"}'),
  ('{"event_id":"e-004","event_time":"2026-03-01T10:01:05Z","ingested_at":"2026-03-01T10:01:06Z","event_type":"page_view","visitor_id":"u-001","latency_ms":130,"page":"/home","source":"web"}'),
  ('{"event_id":"e-005","event_time":"2026-03-01T10:01:15Z","ingested_at":"2026-03-01T10:01:16Z","event_type":"click","visitor_id":"u-004","latency_ms":125,"page":"/product/2","source":"app"}'),
  ('{"event_id":"e-006","event_time":"2026-03-01T10:01:25Z","ingested_at":"2026-03-01T10:01:26Z","event_type":"heartbeat","visitor_id":"u-004","latency_ms":80,"page":"/","source":"app"}'),
  ('{"event_id":"e-007","event_time":"2026-03-01T10:02:05Z","ingested_at":"2026-03-01T10:02:06Z","event_type":"page_view","visitor_id":"u-005","latency_ms":100,"page":"/home","source":"web"}'),
  ('{"event_id":"e-008","event_time":"2026-03-01T10:02:15Z","ingested_at":"2026-03-01T10:02:16Z","event_type":"page_view","visitor_id":"u-006","latency_ms":120,"page":"/search","source":"web"}'),
  ('{"event_id":"e-009","event_time":"2026-03-01T10:02:25Z","ingested_at":"2026-03-01T10:02:26Z","event_type":"click","visitor_id":"u-007","latency_ms":140,"page":"/product/3","source":"app"}'),
  ('{"event_id":"e-010","event_time":"2026-03-01T10:02:35Z","ingested_at":"2026-03-01T10:02:36Z","event_type":"page_view","visitor_id":"u-008","latency_ms":160,"page":"/category","source":"web"}'),
  ('{"event_id":"e-011","event_time":"2026-03-01T10:02:45Z","ingested_at":"2026-03-01T10:02:46Z","event_type":"purchase","visitor_id":"u-009","latency_ms":180,"page":"/checkout","source":"app"}'),
  ('{"event_time":"2026-03-01T10:03:00Z","ingested_at":"2026-03-01T10:03:01Z","event_type":"page_view","visitor_id":"u-010","latency_ms":100,"page":"/home","source":"web"}'),
  ('{"event_id":"bad-time","event_time":"not-a-date","ingested_at":"2026-03-01T10:03:02Z","event_type":"page_view","visitor_id":"u-011","latency_ms":100,"page":"/home","source":"web"}'),
  ('{"event_id":"bad-latency","event_time":"2026-03-01T10:03:03Z","ingested_at":"2026-03-01T10:03:04Z","event_type":"click","visitor_id":"u-012","latency_ms":"oops","page":"/home","source":"web"}'),
  ('{"event_id":"bad-type","event_time":"2026-03-01T10:03:05Z","ingested_at":"2026-03-01T10:03:06Z","event_type":"mystery","visitor_id":"u-013","latency_ms":100,"page":"/home","source":"web"}'),
  ('{"event_id":"bad-visitor","event_time":"2026-03-01T10:03:07Z","ingested_at":"2026-03-01T10:03:08Z","event_type":"page_view","visitor_id":"","latency_ms":100,"page":"/home","source":"web"}');

-- 额外生成 20,000 条 Kafka 风格 JSON 事件，覆盖 200 个分钟桶。
insert into traffic_lab.raw_kafka_events(value)
select jsonb_build_object(
  'event_id',
  format('bulk-%s', lpad(series_no::text, 6, '0')),
  'event_time',
  to_char(
    (
      '2026-03-01 11:00:00+00'::timestamptz
      + ((series_no - 1) / 100) * interval '1 minute'
      + ((series_no - 1) % 60) * interval '1 second'
    ) at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS"Z"'
  ),
  'ingested_at',
  to_char(
    (
      '2026-03-01 11:00:01+00'::timestamptz
      + ((series_no - 1) / 100) * interval '1 minute'
      + ((series_no - 1) % 60) * interval '1 second'
    ) at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS"Z"'
  ),
  'event_type',
  (array['page_view', 'click', 'purchase', 'heartbeat'])[
    ((series_no - 1) % 4) + 1
  ],
  'visitor_id',
  format('bulk-user-%s', ((series_no - 1) % 500) + 1),
  'latency_ms',
  80 + (series_no % 120),
  'page',
  format('/generated/%s', series_no % 25),
  'source',
  (array['web', 'app'])[((series_no - 1) % 2) + 1]
)
from generate_series(1, 20000) as series_no;

analyze traffic_lab.raw_kafka_events;

commit;
