begin;

create schema commerce;
create schema "电商运营";

create type commerce.customer_tier as enum ('standard', 'silver', 'gold');
create type commerce.order_state as enum (
  'pending',
  'paid',
  'partially_refunded',
  'refunded',
  'cancelled'
);

create table commerce.customers (
  customer_id bigint primary key,
  customer_no text not null unique,
  display_name text not null,
  city text not null,
  tier commerce.customer_tier not null,
  profile jsonb not null default '{}'::jsonb,
  registered_at timestamptz not null
);

create table commerce.products (
  product_id bigint primary key,
  sku text not null unique,
  product_name text not null,
  category text not null,
  list_price numeric(14, 2) not null check (list_price >= 0),
  attributes jsonb not null default '{}'::jsonb
);

create table commerce.warehouses (
  warehouse_id bigint primary key,
  warehouse_code text not null unique,
  warehouse_name text not null,
  city text not null
);

create table commerce.inventory (
  warehouse_id bigint not null references commerce.warehouses(warehouse_id),
  product_id bigint not null references commerce.products(product_id),
  on_hand_qty integer not null check (on_hand_qty >= 0),
  reserved_qty integer not null default 0
    check (reserved_qty >= 0 and reserved_qty <= on_hand_qty),
  reorder_point integer not null default 0 check (reorder_point >= 0),
  updated_at timestamptz not null,
  primary key (warehouse_id, product_id)
);

create table commerce.orders (
  order_id bigint primary key,
  order_no text not null unique,
  customer_id bigint not null references commerce.customers(customer_id),
  channel text not null check (channel in ('app', 'web', 'wechat')),
  state commerce.order_state not null,
  currency char(3) not null default 'CNY',
  created_at timestamptz not null,
  metadata jsonb not null default '{}'::jsonb
);

create table commerce.order_items (
  order_id bigint not null references commerce.orders(order_id) on delete cascade,
  line_no integer not null,
  product_id bigint not null references commerce.products(product_id),
  warehouse_id bigint not null references commerce.warehouses(warehouse_id),
  quantity integer not null check (quantity > 0),
  unit_price numeric(14, 2) not null check (unit_price >= 0),
  discount_amount numeric(14, 2) not null default 0 check (discount_amount >= 0),
  primary key (order_id, line_no)
);

create table commerce.payments (
  payment_id bigint primary key,
  order_id bigint not null references commerce.orders(order_id),
  provider text not null,
  provider_trade_no text not null unique,
  status text not null check (status in ('settled', 'failed', 'voided')),
  paid_amount numeric(14, 2) not null check (paid_amount >= 0),
  paid_at timestamptz
);

create table commerce.refunds (
  refund_id bigint primary key,
  payment_id bigint not null references commerce.payments(payment_id),
  refund_no text not null unique,
  status text not null check (status in ('succeeded', 'failed', 'processing')),
  refund_amount numeric(14, 2) not null check (refund_amount > 0),
  refunded_at timestamptz
);

create table "电商运营"."渠道目标" (
  "月份" date not null,
  "渠道" text not null,
  "目标净收入" numeric(14, 2) not null check ("目标净收入" >= 0),
  primary key ("月份", "渠道")
);

comment on schema commerce is '电商平台验收场景；覆盖客户、商品、库存、订单、支付和退款';
comment on table commerce.orders is '订单头；净收入必须按已结算支付减成功退款计算';
comment on table commerce.inventory is '仓库商品库存；可售数量 = on_hand_qty - reserved_qty';
comment on table "电商运营"."渠道目标" is '中文业务对象；用于比较渠道实际净收入与月度目标';

create index idx_commerce_orders_customer_created
  on commerce.orders(customer_id, created_at desc);
create index idx_commerce_orders_state_created
  on commerce.orders(state, created_at desc);
create index idx_commerce_order_items_product
  on commerce.order_items(product_id, order_id);
create index idx_commerce_payments_order_status
  on commerce.payments(order_id, status);
create index idx_commerce_refunds_payment_status
  on commerce.refunds(payment_id, status);
create index idx_commerce_orders_metadata
  on commerce.orders using gin(metadata);

insert into commerce.customers (
  customer_id,
  customer_no,
  display_name,
  city,
  tier,
  profile,
  registered_at
) values
  (1, 'C001', '林晓', '上海', 'gold', '{"industry":"software","language":"zh-CN"}', '2025-12-10 01:00:00+00'),
  (2, 'C002', 'Chen Rui', '北京', 'silver', '{"industry":"retail","language":"en-US"}', '2025-12-11 02:00:00+00'),
  (3, 'C003', '周然', '深圳', 'standard', '{"industry":"education","language":"zh-CN"}', '2025-12-12 03:00:00+00'),
  (4, 'C004', 'Avery Sun', '杭州', 'gold', '{"industry":"finance","language":"en-US"}', '2025-12-13 04:00:00+00'),
  (5, 'C005', '李沐', '成都', 'silver', '{"industry":"manufacturing","language":"zh-CN"}', '2025-12-14 05:00:00+00');

insert into commerce.products (
  product_id,
  sku,
  product_name,
  category,
  list_price,
  attributes
) values
  (1, 'EC-KEYBOARD', '机械键盘', 'electronics', 150.00, '{"switch":"red","layout":"ANSI"}'),
  (2, 'EC-MONITOR', '4K Monitor', 'electronics', 300.00, '{"size_inch":27,"ports":["HDMI","USB-C"]}'),
  (3, 'EC-CHAIR', '人体工学椅', 'furniture', 500.00, '{"material":"mesh","color":"gray"}'),
  (4, 'EC-HUB', 'USB-C Hub', 'electronics', 120.00, '{"ports":8,"power_delivery":true}'),
  (5, 'EC-SENSOR', '环境传感器', 'iot', 250.00, '{"metrics":["temperature","humidity"]}');

insert into commerce.warehouses (
  warehouse_id,
  warehouse_code,
  warehouse_name,
  city
) values
  (1, 'WH-SH-01', '上海中心仓', '上海'),
  (2, 'WH-CD-01', '成都西部仓', '成都');

insert into commerce.inventory (
  warehouse_id,
  product_id,
  on_hand_qty,
  reserved_qty,
  reorder_point,
  updated_at
)
select
  warehouse_id,
  product_id,
  100 + warehouse_id * 10 + product_id,
  product_id,
  20,
  '2026-03-01 00:00:00+00'::timestamptz
from commerce.warehouses
cross join commerce.products;

insert into commerce.orders (
  order_id,
  order_no,
  customer_id,
  channel,
  state,
  created_at,
  metadata
) values
  (1001, 'EC-2026-1001', 1, 'wechat', 'paid', '2026-01-05 02:00:00+00', '{"campaign":"new-year"}'),
  (1002, 'EC-2026-1002', 2, 'app', 'partially_refunded', '2026-01-08 03:00:00+00', '{"campaign":"app-launch"}'),
  (1003, 'EC-2026-1003', 1, 'web', 'paid', '2026-01-18 04:00:00+00', '{"campaign":"organic"}'),
  (1004, 'EC-2026-1004', 3, 'app', 'cancelled', '2026-01-20 05:00:00+00', '{"cancel_reason":"payment_timeout"}'),
  (2001, 'EC-2026-2001', 4, 'wechat', 'paid', '2026-02-02 02:00:00+00', '{"campaign":"spring"}'),
  (2002, 'EC-2026-2002', 2, 'app', 'paid', '2026-02-09 03:00:00+00', '{"campaign":"retention"}'),
  (2003, 'EC-2026-2003', 5, 'web', 'partially_refunded', '2026-02-12 04:00:00+00', '{"campaign":"spring"}'),
  (2004, 'EC-2026-2004', 1, 'web', 'paid', '2026-02-21 05:00:00+00', '{"campaign":"organic"}');

insert into commerce.order_items (
  order_id,
  line_no,
  product_id,
  warehouse_id,
  quantity,
  unit_price,
  discount_amount
) values
  (1001, 1, 1, 1, 1, 150.00, 0.00),
  (1002, 1, 2, 1, 1, 300.00, 100.00),
  (1003, 1, 2, 1, 1, 300.00, 0.00),
  (1004, 1, 4, 1, 1, 120.00, 0.00),
  (2001, 1, 3, 2, 1, 500.00, 0.00),
  (2002, 1, 5, 2, 1, 250.00, 0.00),
  (2003, 1, 2, 2, 1, 300.00, 0.00),
  (2003, 2, 1, 2, 1, 150.00, 50.00),
  (2004, 1, 4, 1, 1, 120.00, 0.00);

insert into commerce.payments (
  payment_id,
  order_id,
  provider,
  provider_trade_no,
  status,
  paid_amount,
  paid_at
) values
  (1, 1001, 'wechat_pay', 'WX-1001', 'settled', 150.00, '2026-01-05 02:01:00+00'),
  (2, 1002, 'alipay', 'ALI-1002', 'settled', 200.00, '2026-01-08 03:01:00+00'),
  (3, 1003, 'unionpay', 'UP-1003', 'settled', 300.00, '2026-01-18 04:01:00+00'),
  (4, 1004, 'alipay', 'ALI-1004', 'failed', 120.00, null),
  (5, 2001, 'wechat_pay', 'WX-2001', 'settled', 500.00, '2026-02-02 02:01:00+00'),
  (6, 2002, 'alipay', 'ALI-2002', 'settled', 250.00, '2026-02-09 03:01:00+00'),
  (7, 2003, 'unionpay', 'UP-2003', 'settled', 400.00, '2026-02-12 04:01:00+00'),
  (8, 2004, 'wechat_pay', 'WX-2004', 'settled', 120.00, '2026-02-21 05:01:00+00');

insert into commerce.refunds (
  refund_id,
  payment_id,
  refund_no,
  status,
  refund_amount,
  refunded_at
) values
  (1, 2, 'RF-1002-01', 'succeeded', 40.00, '2026-01-10 03:00:00+00'),
  (2, 7, 'RF-2003-01', 'succeeded', 100.00, '2026-02-15 04:00:00+00'),
  (3, 7, 'RF-2003-02', 'failed', 50.00, '2026-02-16 04:00:00+00');

-- 额外生成 20,000 个已结算订单，用于真实聚合与索引性能验收。
insert into commerce.orders (
  order_id,
  order_no,
  customer_id,
  channel,
  state,
  created_at,
  metadata
)
select
  10000 + series_no,
  format('EC-BULK-%s', lpad(series_no::text, 6, '0')),
  ((series_no - 1) % 5) + 1,
  (array['app', 'web', 'wechat'])[((series_no - 1) % 3) + 1],
  'paid',
  '2026-03-01 00:00:00+00'::timestamptz
    + ((series_no - 1) % 744) * interval '1 hour',
  jsonb_build_object('fixture', 'performance', 'batch', (series_no - 1) / 1000)
from generate_series(1, 20000) as series_no;

insert into commerce.order_items (
  order_id,
  line_no,
  product_id,
  warehouse_id,
  quantity,
  unit_price,
  discount_amount
)
select
  10000 + series_no,
  1,
  ((series_no - 1) % 5) + 1,
  ((series_no - 1) % 2) + 1,
  1,
  1.00,
  0.00
from generate_series(1, 20000) as series_no;

insert into commerce.payments (
  payment_id,
  order_id,
  provider,
  provider_trade_no,
  status,
  paid_amount,
  paid_at
)
select
  10000 + series_no,
  10000 + series_no,
  (array['alipay', 'wechat_pay', 'unionpay'])[((series_no - 1) % 3) + 1],
  format('PERF-%s', lpad(series_no::text, 6, '0')),
  'settled',
  1.00,
  '2026-03-01 00:00:01+00'::timestamptz
    + ((series_no - 1) % 744) * interval '1 hour'
from generate_series(1, 20000) as series_no;

insert into "电商运营"."渠道目标" ("月份", "渠道", "目标净收入") values
  ('2026-01-01', 'wechat', 100.00),
  ('2026-01-01', 'app', 180.00),
  ('2026-01-01', 'web', 250.00),
  ('2026-02-01', 'wechat', 450.00),
  ('2026-02-01', 'app', 200.00),
  ('2026-02-01', 'web', 500.00);

analyze commerce.orders;
analyze commerce.order_items;
analyze commerce.payments;

commit;
