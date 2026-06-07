create table if not exists users (
  id bigserial primary key,
  email text not null unique,
  city text not null,
  created_at timestamptz not null default now()
);

create table if not exists orders (
  id bigserial primary key,
  user_id bigint not null references users(id),
  total_amount numeric(12, 2) not null,
  status text not null,
  created_at timestamptz not null default now()
);

insert into users (email, city)
values
  ('alice@example.com', 'Shanghai'),
  ('bob@example.com', 'Beijing')
on conflict do nothing;

insert into orders (user_id, total_amount, status)
select id, 128.50, 'paid' from users where email = 'alice@example.com'
on conflict do nothing;
