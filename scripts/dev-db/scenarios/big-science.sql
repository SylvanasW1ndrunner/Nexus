begin;

create schema science;

create type science.experiment_status as enum (
  'planned',
  'running',
  'completed',
  'archived'
);

create table science.experiments (
  experiment_id integer primary key,
  experiment_code text not null unique,
  title text not null,
  status science.experiment_status not null,
  principal_investigator text not null,
  started_at timestamptz not null,
  parameters jsonb not null default '{}'::jsonb
);

create table science.samples (
  sample_id integer primary key,
  experiment_id integer not null references science.experiments(experiment_id),
  sample_code text not null unique,
  species text not null,
  treatment_group text not null,
  concentration_molar numeric(30, 18) not null,
  tags text[] not null default '{}'
);

create table science.instruments (
  instrument_id integer primary key,
  instrument_code text not null unique,
  instrument_type text not null,
  calibration jsonb not null
);

create table science.observations (
  observation_id bigint generated always as identity,
  experiment_id integer not null references science.experiments(experiment_id),
  sample_id integer not null references science.samples(sample_id),
  instrument_id integer not null references science.instruments(instrument_id),
  observed_at timestamptz not null,
  signal numeric(24, 8) not null,
  background numeric(24, 8) not null,
  quality_flags integer[] not null default '{}',
  metadata jsonb not null default '{}'::jsonb,
  primary key (observation_id, observed_at)
) partition by range (observed_at);

create table science.observations_2026_01
  partition of science.observations
  for values from ('2026-01-01 00:00:00+00') to ('2026-02-01 00:00:00+00');

create table science.observations_2026_02
  partition of science.observations
  for values from ('2026-02-01 00:00:00+00') to ('2026-03-01 00:00:00+00');

create table science.gene_expression_wide (
  sample_id integer primary key references science.samples(sample_id),
  gene_tp53 numeric(30, 12) not null,
  gene_brca1 numeric(30, 12) not null,
  gene_egfr numeric(30, 12) not null,
  gene_myc numeric(30, 12) not null,
  spectral_channels numeric(30, 12)[] not null,
  qc_metrics jsonb not null
);

comment on schema science is '大科学数据验收场景；覆盖实验、样本、仪器、分区观测和宽表';
comment on table science.observations is
  '高精度时序观测事实表；按 observed_at 月份分区';
comment on table science.gene_expression_wide is
  '基因表达宽表；包含高精度列、光谱数组和 JSON 质量指标';

create index idx_science_observations_experiment_sample_time
  on science.observations(experiment_id, sample_id, observed_at);
create index idx_science_observations_time_brin
  on science.observations using brin(observed_at);
create index idx_science_observations_quality_flags
  on science.observations using gin(quality_flags);
create index idx_science_samples_tags
  on science.samples using gin(tags);

insert into science.experiments (
  experiment_id,
  experiment_code,
  title,
  status,
  principal_investigator,
  started_at,
  parameters
) values
  (
    1,
    'EXP-PHOTON-001',
    'Photon detector stability',
    'completed',
    'Dr. Lin',
    '2026-01-01 00:00:00+00',
    '{"beam_energy_gev":240,"temperature_k":4.2}'
  ),
  (
    2,
    'EXP-GENOME-002',
    'Stress response expression',
    'completed',
    'Dr. Zhou',
    '2026-01-01 00:00:00+00',
    '{"assay":"RNA-Seq","reference":"GRCh38"}'
  );

insert into science.samples (
  sample_id,
  experiment_id,
  sample_code,
  species,
  treatment_group,
  concentration_molar,
  tags
)
select
  sample_id,
  case when sample_id <= 6 then 1 else 2 end,
  format('S-%s', lpad(sample_id::text, 3, '0')),
  case when sample_id <= 6 then 'reference-material' else 'Homo sapiens' end,
  case
    when sample_id % 3 = 0 then 'high-dose'
    when sample_id % 3 = 1 then 'control'
    else 'low-dose'
  end,
  (sample_id::numeric * 0.000000000001)::numeric(30, 18),
  array[
    case when sample_id <= 6 then 'detector' else 'transcriptome' end,
    case when sample_id % 2 = 0 then 'replicate-a' else 'replicate-b' end
  ]
from generate_series(1, 12) as sample_id;

insert into science.instruments (
  instrument_id,
  instrument_code,
  instrument_type,
  calibration
) values
  (1, 'DET-ALPHA', 'photon-detector', '{"gain":1.0004,"offset":-0.12}'),
  (2, 'SEQ-NOVA', 'sequencer', '{"read_length":150,"paired_end":true}');

insert into science.observations (
  experiment_id,
  sample_id,
  instrument_id,
  observed_at,
  signal,
  background,
  quality_flags,
  metadata
)
select
  case when sample_id <= 6 then 1 else 2 end,
  sample_id,
  case when sample_id <= 6 then 1 else 2 end,
  '2026-01-01 00:00:00+00'::timestamptz
    + (series_no - 1) * interval '1 second',
  (
    1000
    + case when sample_id <= 6 then 10 else 20 end
    + (series_no % 400) * 0.25
  )::numeric(24, 8),
  (50 + (series_no % 50) * 0.1)::numeric(24, 8),
  case when series_no % 997 = 0 then array[1, 7] else '{}'::integer[] end,
  jsonb_build_object(
    'run_id',
    'JAN-' || lpad(series_no::text, 5, '0'),
    'replicate',
    1 + series_no % 3
  )
from (
  select
    series_no,
    ((series_no - 1) % 12 + 1)::integer as sample_id
  from generate_series(1, 12000) as series_no
) generated;

insert into science.observations (
  experiment_id,
  sample_id,
  instrument_id,
  observed_at,
  signal,
  background,
  quality_flags,
  metadata
)
select
  case when sample_id <= 6 then 1 else 2 end,
  sample_id,
  case when sample_id <= 6 then 1 else 2 end,
  '2026-02-01 00:00:00+00'::timestamptz
    + (series_no - 1) * interval '1 second',
  (
    1010
    + case when sample_id <= 6 then 10 else 20 end
    + (series_no % 400) * 0.25
  )::numeric(24, 8),
  (50 + (series_no % 50) * 0.1)::numeric(24, 8),
  case when series_no % 991 = 0 then array[2, 9] else '{}'::integer[] end,
  jsonb_build_object(
    'run_id',
    'FEB-' || lpad(series_no::text, 5, '0'),
    'replicate',
    1 + series_no % 3
  )
from (
  select
    series_no,
    ((series_no - 1) % 12 + 1)::integer as sample_id
  from generate_series(1, 12000) as series_no
) generated;

insert into science.gene_expression_wide (
  sample_id,
  gene_tp53,
  gene_brca1,
  gene_egfr,
  gene_myc,
  spectral_channels,
  qc_metrics
)
select
  sample_id,
  (10 + sample_id * 0.125)::numeric(30, 12),
  (20 + sample_id * 0.250)::numeric(30, 12),
  (30 + sample_id * 0.375)::numeric(30, 12),
  (40 + sample_id * 0.500)::numeric(30, 12),
  array[
    (sample_id * 0.001)::numeric(30, 12),
    (sample_id * 0.002)::numeric(30, 12),
    (sample_id * 0.003)::numeric(30, 12),
    (sample_id * 0.004)::numeric(30, 12)
  ],
  jsonb_build_object(
    'mapping_rate',
    0.90 + sample_id * 0.005,
    'duplicate_rate',
    0.01 + sample_id * 0.001
  )
from generate_series(1, 12) as sample_id;

analyze science.samples;
analyze science.observations;
analyze science.gene_expression_wide;

commit;
