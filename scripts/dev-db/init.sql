create schema analytics;
create schema "供应链";

create type order_status as enum ('pending', 'paid', 'refunded', 'cancelled');

create table users (
  id bigserial primary key,
  email text not null unique,
  city text not null,
  manager_id bigint references users(id),
  profile jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
comment on table users is '用户维度表；manager_id 形成自引用组织树';
comment on column users.city is '用户常驻城市';

create table products (
  id bigserial primary key,
  sku text not null unique,
  name text not null,
  category text not null,
  attributes jsonb not null default '{}'::jsonb,
  list_price numeric(12, 2) not null check (list_price >= 0)
);
comment on table products is '商品主数据，attributes 保存动态规格';

create table orders (
  id bigserial primary key,
  order_no text not null unique,
  user_id bigint not null references users(id),
  total_amount numeric(12, 2) not null check (total_amount >= 0),
  refunded_amount numeric(12, 2) not null default 0 check (refunded_amount >= 0),
  currency char(3) not null default 'CNY',
  status order_status not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table orders is '订单事实表；净收入 = total_amount - refunded_amount';
comment on column orders.payload is '订单扩展 JSON，包含 channel、coupon 和 delivery';

create table order_items (
  order_id bigint not null references orders(id) on delete cascade,
  line_no integer not null,
  product_id bigint not null references products(id),
  quantity integer not null check (quantity > 0),
  unit_price numeric(12, 2) not null check (unit_price >= 0),
  discount_amount numeric(12, 2) not null default 0,
  primary key (order_id, line_no)
);
comment on table order_items is '订单明细；复合主键为 order_id + line_no';

create table payments (
  id bigserial primary key,
  order_id bigint not null references orders(id),
  provider text not null,
  paid_amount numeric(12, 2) not null,
  paid_at timestamptz,
  metadata jsonb not null default '{}'::jsonb
);

create table events (
  id bigserial primary key,
  topic text not null,
  event_key text,
  value jsonb not null,
  headers jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now()
);
comment on table events is 'Kafka 原始事件表；业务字段全部位于 value JSONB';
comment on column events.value is '常见路径：order.id、order.status、customer.province、amount、items[]';

create table orders_archive (
  like orders including defaults including constraints including comments
);
comment on table orders_archive is '历史订单归档；名称与 orders 相似，用于检索消歧';

create table "供应链"."供应商" (
  "供应商ID" bigserial primary key,
  "供应商名称" text not null unique,
  "所在省份" text not null,
  "评级" text not null check ("评级" in ('A', 'B', 'C'))
);

create table "供应链"."采购订单" (
  "采购单号" text primary key,
  "供应商ID" bigint not null references "供应链"."供应商"("供应商ID"),
  "下单日期" date not null,
  "状态" text not null,
  "含税金额" numeric(14, 2) not null,
  "扩展信息" jsonb not null default '{}'::jsonb
);

create table "供应链"."采购明细" (
  "采购单号" text not null references "供应链"."采购订单"("采购单号"),
  "行号" integer not null,
  "商品编码" text not null,
  "数量" integer not null check ("数量" > 0),
  "未税单价" numeric(14, 4) not null,
  primary key ("采购单号", "行号")
);

comment on table "供应链"."采购订单" is '中文供应链采购订单事实表';
comment on column "供应链"."采购订单"."扩展信息" is '包含交付方式、采购员和标签数组';

create index idx_orders_user_created on orders(user_id, created_at desc);
create index idx_orders_status_created on orders(status, created_at desc);
create index idx_events_topic_received on events(topic, received_at desc);
create index idx_events_value_gin on events using gin(value);

insert into users (email, city, profile, created_at)
values
  ('alice@example.com', 'Shanghai', '{"segment":"vip","language":"zh-CN"}', '2026-06-01 01:00:00+00'),
  ('bob@example.com', 'Beijing', '{"segment":"standard","language":"zh-CN"}', '2026-06-02 02:00:00+00'),
  ('carol@example.com', 'Shenzhen', '{"segment":"vip","language":"en-US"}', '2026-06-03 03:00:00+00'),
  ('david@example.com', 'Shanghai', '{"segment":"new","language":"zh-CN"}', '2026-06-04 04:00:00+00');

update users
set manager_id = (select id from users where email = 'alice@example.com')
where email in ('bob@example.com', 'carol@example.com');

insert into products (sku, name, category, attributes, list_price)
values
  ('SKU-100', 'Mechanical Keyboard', 'electronics', '{"color":"black","switch":"red"}', 399.00),
  ('SKU-200', '4K Monitor', 'electronics', '{"size":27,"ports":["HDMI","USB-C"]}', 2199.00),
  ('SKU-300', 'Office Chair', 'furniture', '{"material":"mesh","color":"gray"}', 1299.00);

insert into orders (
  order_no, user_id, total_amount, refunded_amount, status, payload, created_at
)
select 'ORD-1001', id, 128.50, 0, 'paid'::order_status,
       '{"channel":"wechat","coupon":"NEW10","delivery":{"type":"express"}}'::jsonb,
       '2026-06-05 02:00:00+00'::timestamptz
from users where email = 'alice@example.com'
union all
select 'ORD-1002', id, 2199.00, 199.00, 'refunded'::order_status,
       '{"channel":"app","delivery":{"type":"same_day"}}'::jsonb,
       '2026-06-06 03:00:00+00'::timestamptz
from users where email = 'bob@example.com'
union all
select 'ORD-1003', id, 799.00, 0, 'paid'::order_status,
       '{"channel":"web","coupon":null,"delivery":{"type":"express"}}'::jsonb,
       '2026-07-01 04:00:00+00'::timestamptz
from users where email = 'carol@example.com'
union all
select 'ORD-1004', id, 1598.00, 0, 'paid'::order_status,
       '{"channel":"app","coupon":"VIP20","delivery":{"type":"pickup"}}'::jsonb,
       '2026-07-02 05:00:00+00'::timestamptz
from users where email = 'alice@example.com'
union all
select 'ORD-1005', id, 399.00, 0, 'pending'::order_status,
       '{"channel":"web","delivery":{"type":"express"}}'::jsonb,
       '2026-07-03 06:00:00+00'::timestamptz
from users where email = 'david@example.com';

insert into order_items (order_id, line_no, product_id, quantity, unit_price, discount_amount)
select o.id, 1, p.id, 1, 399.00, 270.50
from orders o join products p on p.sku = 'SKU-100' where o.order_no = 'ORD-1001'
union all
select o.id, 1, p.id, 1, 2199.00, 0
from orders o join products p on p.sku = 'SKU-200' where o.order_no = 'ORD-1002'
union all
select o.id, 1, p.id, 2, 399.00, 0
from orders o join products p on p.sku = 'SKU-100' where o.order_no = 'ORD-1003'
union all
select o.id, 1, p.id, 1, 1299.00, 0
from orders o join products p on p.sku = 'SKU-300' where o.order_no = 'ORD-1004'
union all
select o.id, 2, p.id, 1, 399.00, 100.00
from orders o join products p on p.sku = 'SKU-100' where o.order_no = 'ORD-1004';

insert into payments (order_id, provider, paid_amount, paid_at, metadata)
select id, 'alipay', total_amount, created_at + interval '2 minutes', '{"trade_state":"SUCCESS"}'
from orders where status in ('paid', 'refunded');

insert into events (topic, event_key, value, headers, received_at)
values
  (
    'order-events',
    'ORD-1001',
    '{"order":{"id":"ORD-1001","status":"paid"},"customer":{"province":"Shanghai"},"amount":128.50,"items":[{"sku":"SKU-100","qty":1}]}',
    '{"source":"order-service","trace_id":"trace-1"}',
    '2026-06-05 02:02:00+00'
  ),
  (
    'order-events',
    'ORD-1002',
    '{"order":{"id":"ORD-1002","status":"refunded"},"customer":{"province":"Beijing"},"amount":2199.00,"items":[{"sku":"SKU-200","qty":1}]}',
    '{"source":"payment-service","trace_id":"trace-2"}',
    '2026-06-06 03:05:00+00'
  ),
  (
    'order-events',
    'ORD-1003',
    '{"order":{"id":"ORD-1003","status":"paid"},"customer":{"province":"Guangdong"},"amount":799.00,"items":[{"sku":"SKU-100","qty":2}]}',
    '{"source":"order-service","trace_id":"trace-3"}',
    '2026-07-01 04:02:00+00'
  ),
  (
    'inventory-events',
    'SKU-100',
    '{"sku":"SKU-100","warehouse":"SH-01","delta":-2,"reason":"sale"}',
    '{"source":"inventory-service"}',
    '2026-07-01 04:03:00+00'
  );

insert into "供应链"."供应商" ("供应商名称", "所在省份", "评级")
values
  ('华东电子', '江苏', 'A'),
  ('南方办公', '广东', 'B');

insert into "供应链"."采购订单" (
  "采购单号", "供应商ID", "下单日期", "状态", "含税金额", "扩展信息"
)
select 'PO-2026-001', "供应商ID", '2026-06-10'::date, '已入库', 56000.00,
       '{"交付方式":"公路","采购员":"张三","标签":["加急","电子"]}'::jsonb
from "供应链"."供应商" where "供应商名称" = '华东电子'
union all
select 'PO-2026-002', "供应商ID", '2026-07-05'::date, '运输中', 18000.00,
       '{"交付方式":"铁路","采购员":"李四","标签":["办公"]}'::jsonb
from "供应链"."供应商" where "供应商名称" = '南方办公';

insert into "供应链"."采购明细" ("采购单号", "行号", "商品编码", "数量", "未税单价")
values
  ('PO-2026-001', 1, 'SKU-100', 100, 350.0000),
  ('PO-2026-001', 2, 'SKU-200', 10, 1900.0000),
  ('PO-2026-002', 1, 'SKU-300', 15, 1061.9469);

create view analytics.city_revenue as
select
  u.city,
  count(o.id) as order_count,
  coalesce(sum(o.total_amount - o.refunded_amount), 0)::numeric(14, 2) as net_revenue
from users u
left join orders o on o.user_id = u.id and o.status in ('paid', 'refunded')
group by u.city;

create materialized view analytics.monthly_revenue as
select
  date_trunc('month', created_at at time zone 'Asia/Shanghai')::date as month,
  currency,
  sum(total_amount - refunded_amount)::numeric(14, 2) as net_revenue
from orders
where status in ('paid', 'refunded')
group by 1, 2;

create function analytics.net_order_amount(
  total numeric,
  refunded numeric
) returns numeric
language sql
immutable
as $$
  select coalesce(total, 0) - coalesce(refunded, 0)
$$;
