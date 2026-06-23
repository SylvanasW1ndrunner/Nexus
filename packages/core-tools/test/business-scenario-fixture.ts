import type { ColumnSummary, TableDetail } from '@dbagent/shared';
import type { SchemaRagGlossaryEntry } from '@dbagent/core-rag';

export const BUSINESS_CONNECTION_ID = 'business_fixture';

export function businessFixtureTables(): TableDetail[] {
  return [
    {
      schema: 'public',
      name: 'customers',
      type: 'table',
      comment: '客户主表，保存注册渠道、城市、会员等级和安全字段标记',
      primaryKey: ['id'],
      columns: [
        column('id', 1, 'uuid', false, '客户 ID', true),
        column('email', 2, 'text', false, '客户邮箱'),
        column('phone_enc', 3, 'bytea', true, '加密手机号，只能通过授权解密工具查看'),
        column('city', 4, 'text', false, '注册城市'),
        column('signup_channel', 5, 'text', false, '注册来源渠道'),
        column('member_tier', 6, 'text', false, '会员等级'),
        column('created_at', 7, 'timestamptz', false, '注册时间'),
        column('deleted_at', 8, 'timestamptz', true, '软删除时间'),
      ],
    },
    {
      schema: 'public',
      name: 'products',
      type: 'table',
      comment: '商品维表，记录 SKU、类目、品牌和上架状态',
      primaryKey: ['id'],
      columns: [
        column('id', 1, 'uuid', false, '商品 ID', true),
        column('sku', 2, 'text', false, '商品编码'),
        column('category', 3, 'text', false, '商品类目'),
        column('brand', 4, 'text', false, '品牌'),
        column('list_price', 5, 'numeric(12,2)', false, '标价'),
        column('is_active', 6, 'boolean', false, '是否在售'),
      ],
    },
    {
      schema: 'public',
      name: 'orders',
      type: 'table',
      comment: '订单事实表，记录支付状态、订单金额、折扣和归属客户',
      primaryKey: ['id'],
      columns: [
        column('id', 1, 'uuid', false, '订单 ID', true),
        fkColumn('customer_id', 2, 'uuid', false, '下单客户 ID', 'public', 'customers', 'id'),
        column('order_no', 3, 'text', false, '订单号'),
        column('order_status', 4, 'text', false, '订单状态'),
        column('payment_status', 5, 'text', false, '支付状态'),
        column('total_amount', 6, 'numeric(12,2)', false, '订单总金额，GMV 口径来源'),
        column('discount_amount', 7, 'numeric(12,2)', false, '优惠金额'),
        column('currency', 8, 'text', false, '币种'),
        column('created_at', 9, 'timestamptz', false, '下单时间'),
      ],
    },
    {
      schema: 'public',
      name: 'order_items',
      type: 'table',
      comment: '订单明细表，记录每个订单的商品、数量和成交单价',
      primaryKey: ['id'],
      columns: [
        column('id', 1, 'uuid', false, '明细 ID', true),
        fkColumn('order_id', 2, 'uuid', false, '订单 ID', 'public', 'orders', 'id'),
        fkColumn('product_id', 3, 'uuid', false, '商品 ID', 'public', 'products', 'id'),
        column('quantity', 4, 'integer', false, '购买数量'),
        column('unit_price', 5, 'numeric(12,2)', false, '成交单价'),
      ],
    },
    {
      schema: 'public',
      name: 'refunds',
      type: 'table',
      comment: '退款事实表，用于计算退款率、售后金额和异常订单',
      primaryKey: ['id'],
      columns: [
        column('id', 1, 'uuid', false, '退款 ID', true),
        fkColumn('order_id', 2, 'uuid', false, '关联订单 ID', 'public', 'orders', 'id'),
        column('refund_amount', 3, 'numeric(12,2)', false, '退款金额'),
        column('refund_reason', 4, 'text', true, '退款原因'),
        column('created_at', 5, 'timestamptz', false, '退款时间'),
      ],
    },
    {
      schema: 'analytics',
      name: 'traffic_sessions',
      type: 'table',
      comment: '流量会话表，保存访客、渠道、活动和落地页信息',
      primaryKey: ['id'],
      columns: [
        column('id', 1, 'uuid', false, '会话 ID', true),
        fkColumn('customer_id', 2, 'uuid', true, '登录客户 ID', 'public', 'customers', 'id'),
        column('visitor_id', 3, 'text', false, '匿名访客 ID'),
        column('utm_source', 4, 'text', false, '流量来源'),
        column('utm_campaign', 5, 'text', true, '投放活动'),
        column('device_type', 6, 'text', false, '设备类型'),
        column('started_at', 7, 'timestamptz', false, '会话开始时间'),
        column('converted_order_id', 8, 'uuid', true, '转化订单 ID'),
      ],
    },
    {
      schema: 'analytics',
      name: 'page_views',
      type: 'table',
      comment: '页面浏览事件表，用于分析商品详情页、加购页和转化路径',
      primaryKey: ['id'],
      columns: [
        column('id', 1, 'uuid', false, '页面事件 ID', true),
        fkColumn('session_id', 2, 'uuid', false, '会话 ID', 'analytics', 'traffic_sessions', 'id'),
        column('page_type', 3, 'text', false, '页面类型'),
        column('url_path', 4, 'text', false, '访问路径'),
        column('occurred_at', 5, 'timestamptz', false, '访问时间'),
      ],
    },
    {
      schema: 'analytics',
      name: 'campaign_spend',
      type: 'table',
      comment: '广告消耗表，按日期、渠道和活动记录花费，用于 ROI 分析',
      primaryKey: ['spend_date', 'utm_source', 'utm_campaign'],
      columns: [
        column('spend_date', 1, 'date', false, '消耗日期', true),
        column('utm_source', 2, 'text', false, '流量来源', true),
        column('utm_campaign', 3, 'text', false, '投放活动', true),
        column('cost_amount', 4, 'numeric(12,2)', false, '广告花费'),
      ],
    },
    {
      schema: 'analytics',
      name: 'raw_evt',
      type: 'table',
      comment: '脏事件表，无主键且字段缩写，用于验证 RAG 对不规范命名的容错',
      primaryKey: [],
      columns: [
        column('sid', 1, 'text', true, 'session id 缩写'),
        column('evt', 2, 'text', true, 'event name 缩写'),
        column('payload', 3, 'jsonb', true, '原始事件 JSON'),
        column('ts', 4, 'timestamptz', true, '事件时间'),
      ],
    },
  ];
}

export function businessGlossary(): SchemaRagGlossaryEntry[] {
  return [
    {
      term: 'GMV',
      aliases: ['成交额', '销售额', '订单总金额'],
      description: 'GMV 使用 public.orders.total_amount 汇总，通常按订单创建时间聚合',
      documentIds: ['table:public.orders', 'column:public.orders.total_amount', 'column:public.orders.created_at'],
      weight: 70,
    },
    {
      term: '退款率',
      aliases: ['售后率', 'refund rate'],
      description: '退款率需要 refunds.refund_amount 和 orders.total_amount 联合计算',
      documentIds: ['table:public.refunds', 'column:public.refunds.refund_amount', 'table:public.orders'],
      weight: 65,
    },
    {
      term: '转化率',
      aliases: ['conversion rate', 'CVR', '漏斗'],
      description: '转化率需要 traffic_sessions、page_views 和 converted_order_id 或订单关联',
      documentIds: [
        'table:analytics.traffic_sessions',
        'column:analytics.traffic_sessions.converted_order_id',
        'table:analytics.page_views',
      ],
      weight: 65,
    },
    {
      term: 'ROI',
      aliases: ['投产比', '广告回报'],
      description: 'ROI 需要订单 GMV 与 campaign_spend.cost_amount 共同计算',
      documentIds: ['table:analytics.campaign_spend', 'column:analytics.campaign_spend.cost_amount', 'table:public.orders'],
      weight: 60,
    },
  ];
}

export function businessFixtureSql(): string {
  return `
drop schema if exists analytics cascade;
drop table if exists public.refunds cascade;
drop table if exists public.order_items cascade;
drop table if exists public.orders cascade;
drop table if exists public.products cascade;
drop table if exists public.customers cascade;
create schema analytics;

create table public.customers (
  id uuid primary key,
  email text not null,
  phone_enc bytea,
  city text not null,
  signup_channel text not null,
  member_tier text not null,
  created_at timestamptz not null,
  deleted_at timestamptz
);
comment on table public.customers is '客户主表，保存注册渠道、城市、会员等级和安全字段标记';
comment on column public.customers.phone_enc is '加密手机号，只能通过授权解密工具查看';
comment on column public.customers.signup_channel is '注册来源渠道';

create table public.products (
  id uuid primary key,
  sku text not null unique,
  category text not null,
  brand text not null,
  list_price numeric(12,2) not null,
  is_active boolean not null default true
);
comment on table public.products is '商品维表，记录 SKU、类目、品牌和上架状态';

create table public.orders (
  id uuid primary key,
  customer_id uuid not null references public.customers(id),
  order_no text not null unique,
  order_status text not null,
  payment_status text not null,
  total_amount numeric(12,2) not null,
  discount_amount numeric(12,2) not null default 0,
  currency text not null default 'CNY',
  created_at timestamptz not null
);
comment on table public.orders is '订单事实表，记录支付状态、订单金额、折扣和归属客户';
comment on column public.orders.total_amount is '订单总金额，GMV 口径来源';
comment on column public.orders.payment_status is '支付状态';
create index idx_orders_customer_created on public.orders(customer_id, created_at);
create index idx_orders_created_status on public.orders(created_at, payment_status);

create table public.order_items (
  id uuid primary key,
  order_id uuid not null references public.orders(id),
  product_id uuid not null references public.products(id),
  quantity integer not null,
  unit_price numeric(12,2) not null
);
comment on table public.order_items is '订单明细表，记录每个订单的商品、数量和成交单价';

create table public.refunds (
  id uuid primary key,
  order_id uuid not null references public.orders(id),
  refund_amount numeric(12,2) not null,
  refund_reason text,
  created_at timestamptz not null
);
comment on table public.refunds is '退款事实表，用于计算退款率、售后金额和异常订单';
comment on column public.refunds.refund_amount is '退款金额';

create table analytics.traffic_sessions (
  id uuid primary key,
  customer_id uuid references public.customers(id),
  visitor_id text not null,
  utm_source text not null,
  utm_campaign text,
  device_type text not null,
  started_at timestamptz not null,
  converted_order_id uuid
);
comment on table analytics.traffic_sessions is '流量会话表，保存访客、渠道、活动和落地页信息';
comment on column analytics.traffic_sessions.converted_order_id is '转化订单 ID';
create index idx_sessions_source_campaign on analytics.traffic_sessions(utm_source, utm_campaign, started_at);

create table analytics.page_views (
  id uuid primary key,
  session_id uuid not null references analytics.traffic_sessions(id),
  page_type text not null,
  url_path text not null,
  occurred_at timestamptz not null
);
comment on table analytics.page_views is '页面浏览事件表，用于分析商品详情页、加购页和转化路径';

create table analytics.campaign_spend (
  spend_date date not null,
  utm_source text not null,
  utm_campaign text not null,
  cost_amount numeric(12,2) not null,
  primary key (spend_date, utm_source, utm_campaign)
);
comment on table analytics.campaign_spend is '广告消耗表，按日期、渠道和活动记录花费，用于 ROI 分析';

create table analytics.raw_evt (
  sid text,
  evt text,
  payload jsonb,
  ts timestamptz
);
comment on table analytics.raw_evt is '脏事件表，无主键且字段缩写，用于验证 RAG 对不规范命名的容错';

insert into public.customers values
  ('00000000-0000-0000-0000-000000000001','alice@example.test',decode('00','hex'),'Shanghai','seo','gold','2026-05-01T09:00:00Z',null),
  ('00000000-0000-0000-0000-000000000002','bob@example.test',decode('01','hex'),'Beijing','paid_search','silver','2026-05-03T10:00:00Z',null),
  ('00000000-0000-0000-0000-000000000003','carol@example.test',decode('02','hex'),'Shenzhen','social','bronze','2026-05-05T11:00:00Z',null);

insert into public.products values
  ('10000000-0000-0000-0000-000000000001','SKU-CHAIR','furniture','Northwind',299.00,true),
  ('10000000-0000-0000-0000-000000000002','SKU-LAMP','home','Northwind',99.00,true),
  ('10000000-0000-0000-0000-000000000003','SKU-BAG','fashion','Contoso',199.00,true);

insert into public.orders values
  ('20000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','ORD-001','paid','paid',398.00,0,'CNY','2026-06-20T12:00:00Z'),
  ('20000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000002','ORD-002','paid','paid',199.00,20,'CNY','2026-06-21T12:00:00Z'),
  ('20000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000002','ORD-003','pending_ship','paid',299.00,0,'CNY','2026-06-22T12:00:00Z');

insert into public.order_items values
  ('30000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001',1,299.00),
  ('30000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000002',1,99.00),
  ('30000000-0000-0000-0000-000000000003','20000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000003',1,199.00),
  ('30000000-0000-0000-0000-000000000004','20000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000001',1,299.00);

insert into public.refunds values
  ('40000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000002',50.00,'partial refund','2026-06-23T09:00:00Z');

insert into analytics.traffic_sessions values
  ('50000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','v1','seo','brand','desktop','2026-06-20T11:55:00Z','20000000-0000-0000-0000-000000000001'),
  ('50000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000002','v2','paid_search','summer','mobile','2026-06-21T11:50:00Z','20000000-0000-0000-0000-000000000002'),
  ('50000000-0000-0000-0000-000000000003',null,'v3','social','summer','mobile','2026-06-22T10:00:00Z',null);

insert into analytics.page_views values
  ('60000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001','product_detail','/products/SKU-CHAIR','2026-06-20T11:56:00Z'),
  ('60000000-0000-0000-0000-000000000002','50000000-0000-0000-0000-000000000001','checkout','/checkout','2026-06-20T11:59:00Z'),
  ('60000000-0000-0000-0000-000000000003','50000000-0000-0000-0000-000000000002','product_detail','/products/SKU-BAG','2026-06-21T11:52:00Z'),
  ('60000000-0000-0000-0000-000000000004','50000000-0000-0000-0000-000000000003','product_detail','/products/SKU-LAMP','2026-06-22T10:01:00Z');

insert into analytics.campaign_spend values
  ('2026-06-20','seo','brand',20.00),
  ('2026-06-21','paid_search','summer',120.00),
  ('2026-06-22','social','summer',80.00);
`;
}

export function businessFixtureCleanupSql(): string {
  return `
drop schema if exists analytics cascade;
drop table if exists public.refunds cascade;
drop table if exists public.order_items cascade;
drop table if exists public.orders cascade;
drop table if exists public.products cascade;
drop table if exists public.customers cascade;
`;
}

function fkColumn(
  name: string,
  ordinal: number,
  dataType: string,
  nullable: boolean,
  comment: string,
  schema: string,
  table: string,
  foreignColumn: string,
): ColumnSummary {
  return {
    ...column(name, ordinal, dataType, nullable, comment),
    foreignKey: { schema, table, column: foreignColumn },
  };
}

function column(
  name: string,
  ordinal: number,
  dataType: string,
  nullable: boolean,
  comment?: string,
  isPrimaryKey = false,
): ColumnSummary {
  return {
    name,
    ordinal,
    dataType,
    nullable,
    isPrimaryKey,
    ...(comment === undefined ? {} : { comment }),
  };
}
