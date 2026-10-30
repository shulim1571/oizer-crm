-- Oizer CRM: core schema, roles and row-level security.
-- IDs keep the AppSheet "Row ID" values so imported data and links stay stable.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function public.short_id() returns text
language sql volatile set search_path = '' as $$
  select substr(md5(gen_random_uuid()::text), 1, 8)
$$;

create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

create or replace function public.current_email() returns text
language sql stable set search_path = '' as $$
  select coalesce(auth.jwt() ->> 'email', 'system')
$$;

-- ---------------------------------------------------------------------------
-- People & reference tables
-- ---------------------------------------------------------------------------
create table public.managers (
  id          text primary key default public.short_id(),
  first_name  text,
  last_name   text,
  full_name   text generated always as (trim(coalesce(first_name,'') || ' ' || coalesce(last_name,''))) stored,
  phone       text,
  email       text,
  notes       text,
  created_by  text default public.current_email(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.collectors (
  id          text primary key default public.short_id(),
  first_name  text,
  last_name   text,
  full_name   text generated always as (trim(coalesce(first_name,'') || ' ' || coalesce(last_name,''))) stored,
  phone       text,
  email       text,
  notes       text,
  created_by  text default public.current_email(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.donors (
  id                 text primary key default public.short_id(),
  yiddish_title      text,
  yiddish_first_name text,
  yiddish_last_name  text,
  yiddish_suffix     text,
  english_title      text,
  first_name         text,
  last_name          text,
  display_name       text generated always as (
    coalesce(
      nullif(trim(coalesce(first_name,'') || ' ' || coalesce(last_name,'')), ''),
      nullif(trim(coalesce(yiddish_title,'') || ' ' || coalesce(yiddish_first_name,'') || ' ' || coalesce(yiddish_last_name,'') || ' ' || coalesce(yiddish_suffix,'')), ''),
      '(no name)')
  ) stored,
  yiddish_name       text generated always as (
    nullif(trim(coalesce(yiddish_title,'') || ' ' || coalesce(yiddish_first_name,'') || ' ' || coalesce(yiddish_last_name,'') || ' ' || coalesce(yiddish_suffix,'')), '')
  ) stored,
  phone              text,
  email              text,
  address            text,
  ojc_id             text,
  nadvan_id          text,
  matbia_id          text,
  pledger_id         text,
  notes              text,
  created_by         text default public.current_email(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table public.accounts (
  id            text primary key default public.short_id(),
  name          text not null,
  filter_checks boolean not null default false,
  notes         text,
  created_at    timestamptz not null default now()
);

create table public.sources (
  id     text primary key,          -- gateway/device key, e.g. DP_10281
  name   text not null,             -- e.g. "Oizer #1"
  number text
);

-- ---------------------------------------------------------------------------
-- Campaigns
-- ---------------------------------------------------------------------------
create table public.campaigns (
  id              text primary key,                 -- campaign number, e.g. 3134
  campaign_name   text,
  friendly_name   text,
  real_name       text,
  manager_id      text references public.managers(id) on delete set null,
  sub_manager_ids text[] not null default '{}',
  email           text,
  phone           text,
  payment_link    text,
  notes           text,
  exchange        boolean not null default false,
  pin             text,
  archived_at     timestamptz,
  created_by      text default public.current_email(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index on public.campaigns (manager_id);
create index on public.campaigns using gin (sub_manager_ids);

-- ---------------------------------------------------------------------------
-- Money in / out
-- ---------------------------------------------------------------------------
create table public.donations (
  id             text primary key default public.short_id(),
  campaign_id    text references public.campaigns(id) on update cascade on delete set null,
  donor_id       text references public.donors(id) on delete set null,
  donor_label    text,
  collector_id   text references public.collectors(id) on delete set null,
  collector_label text,
  type           text not null default 'Payment' check (type in ('Payment','Batch','Collect','Voided')),
  amount         numeric(12,2) not null default 0,
  fee            numeric(12,2),
  manual_fee     numeric(12,2),
  net_donation   numeric(12,2),
  source         text references public.sources(id) on update cascade on delete set null,
  payment_method text,
  command        text,
  result         text,
  donary_id      text,
  gateway_id     text,
  name           text,
  phone          text,
  email          text,
  notes          text,
  account_id     text references public.accounts(id) on delete set null,
  delivered      boolean,
  is_batch       boolean,
  batch_id       text,
  funded         numeric(12,2),
  batch_status   text,
  batch_pending  numeric(12,2),
  created_by     text default public.current_email(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index on public.donations (campaign_id);
create index on public.donations (donor_id);
create index on public.donations (created_at desc);
create index on public.donations (type);

create or replace function public.donation_defaults() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.net_donation is null then
    new.net_donation := new.amount - coalesce(new.fee, 0);
  end if;
  if new.type = 'Batch' and new.is_batch is null then
    new.is_batch := true;
  end if;
  return new;
end $$;
create trigger donation_defaults before insert on public.donations
  for each row execute function public.donation_defaults();

create table public.expenses (
  id           text primary key default public.short_id(),
  campaign_id  text references public.campaigns(id) on update cascade on delete set null,
  description  text,
  payee        text,
  amount       numeric(12,2) not null default 0,
  memo         text,
  account_id   text references public.accounts(id) on delete set null,
  method       text,
  check_number text,
  cleared      boolean,
  notes        text,
  created_by   text default public.current_email(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index on public.expenses (campaign_id);
create index on public.expenses (created_at desc);

create table public.transfers (
  id               text primary key default public.short_id(),
  amount           numeric(12,2) not null,
  from_campaign_id text references public.campaigns(id) on update cascade on delete set null,
  to_campaign_id   text references public.campaigns(id) on update cascade on delete set null,
  description      text,
  notes            text,
  created_by       text default public.current_email(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index on public.transfers (from_campaign_id);
create index on public.transfers (to_campaign_id);

create table public.pledges (
  id           text primary key default public.short_id(),
  campaign_id  text references public.campaigns(id) on update cascade on delete set null,
  donor_id     text references public.donors(id) on delete set null,
  collector    text,
  donor_label  text,
  amount       numeric(12,2) not null default 0,
  source       text,
  donary_id    text,
  name         text,
  phone        text,
  email        text,
  notes        text,
  created_by   text default public.current_email(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index on public.pledges (campaign_id);

create table public.tasks (
  id           text primary key default public.short_id(),
  campaign_id  text references public.campaigns(id) on update cascade on delete set null,
  donor_id     text references public.donors(id) on delete set null,
  title        text not null,
  description  text,
  assigned_to  text,
  status       text not null default 'Pending' check (status in ('Pending','In Progress','Done')),
  due_date     date,
  notes        text,
  created_by   text default public.current_email(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index on public.tasks (campaign_id);

do $$
declare t text;
begin
  foreach t in array array['managers','collectors','donors','campaigns','donations','expenses','transfers','pledges','tasks'] loop
    execute format('create trigger touch_updated_at before update on public.%I for each row execute function public.touch_updated_at()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Users, roles and campaign access
-- ---------------------------------------------------------------------------
create table public.admin_emails (
  email text primary key           -- anyone signing up with one of these becomes an admin
);

create table public.profiles (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  email      text not null,
  full_name  text,
  role       text not null default 'pending' check (role in ('admin','manager','pending')),
  created_at timestamptz not null default now()
);

create table public.user_managers (
  user_id    uuid not null references public.profiles(user_id) on delete cascade,
  manager_id text not null references public.managers(id) on delete cascade,
  primary key (user_id, manager_id)
);
create index on public.user_managers (manager_id);

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where user_id = auth.uid() and role = 'admin')
$$;

create or replace function public.is_active_user() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where user_id = auth.uid() and role in ('admin','manager'))
$$;

create or replace function public.my_manager_ids() returns text[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(um.manager_id), '{}')
  from public.user_managers um
  join public.profiles p on p.user_id = um.user_id and p.role = 'manager'
  where um.user_id = auth.uid()
$$;

-- Campaigns a manager login may see: they are the manager or one of the sub-managers.
create or replace function public.my_campaign_ids() returns text[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(c.id), '{}')
  from public.campaigns c
  where c.manager_id = any(public.my_manager_ids())
     or c.sub_manager_ids && public.my_manager_ids()
$$;

-- New sign-ups: admin if listed, manager if the email matches a manager record, otherwise pending.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_role text := 'pending';
begin
  if exists (select 1 from public.admin_emails where lower(email) = lower(new.email)) then
    v_role := 'admin';
  elsif exists (select 1 from public.managers where lower(email) = lower(new.email)) then
    v_role := 'manager';
  end if;

  insert into public.profiles (user_id, email, full_name, role)
  values (new.id, new.email, new.raw_user_meta_data ->> 'full_name', v_role);

  if v_role = 'manager' then
    insert into public.user_managers (user_id, manager_id)
    select new.id, m.id from public.managers m where lower(m.email) = lower(new.email)
    on conflict do nothing;
  end if;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
alter table public.managers      enable row level security;
alter table public.collectors    enable row level security;
alter table public.donors        enable row level security;
alter table public.accounts      enable row level security;
alter table public.sources       enable row level security;
alter table public.campaigns     enable row level security;
alter table public.donations     enable row level security;
alter table public.expenses      enable row level security;
alter table public.transfers     enable row level security;
alter table public.pledges       enable row level security;
alter table public.tasks         enable row level security;
alter table public.admin_emails  enable row level security;
alter table public.profiles      enable row level security;
alter table public.user_managers enable row level security;

-- Admins can do everything on every table.
do $$
declare t text;
begin
  foreach t in array array['managers','collectors','donors','accounts','sources','campaigns','donations',
                           'expenses','transfers','pledges','tasks','admin_emails','profiles','user_managers'] loop
    execute format('create policy admin_all on public.%I for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()))', t);
  end loop;
end $$;

-- Reference lists any active user can read.
create policy active_read on public.collectors for select to authenticated using ((select public.is_active_user()));
create policy active_read on public.accounts   for select to authenticated using ((select public.is_active_user()));
create policy active_read on public.sources    for select to authenticated using ((select public.is_active_user()));

-- Managers: their own campaigns and everything attached to them (read-only).
create policy manager_read on public.campaigns for select to authenticated
  using (id = any((select public.my_campaign_ids())::text[]));

create policy manager_read on public.donations for select to authenticated
  using (campaign_id = any((select public.my_campaign_ids())::text[]));

create policy manager_read on public.expenses for select to authenticated
  using (campaign_id = any((select public.my_campaign_ids())::text[]));

create policy manager_read on public.transfers for select to authenticated
  using (from_campaign_id = any((select public.my_campaign_ids())::text[])
      or to_campaign_id   = any((select public.my_campaign_ids())::text[]));

create policy manager_read on public.pledges for select to authenticated
  using (campaign_id = any((select public.my_campaign_ids())::text[]));

create policy manager_read on public.managers for select to authenticated
  using (id = any((select public.my_manager_ids())::text[])
      or id in (select c.manager_id from public.campaigns c where c.id = any((select public.my_campaign_ids())::text[])));

create policy manager_read on public.donors for select to authenticated
  using (id in (select d.donor_id from public.donations d
                where d.campaign_id = any((select public.my_campaign_ids())::text[]) and d.donor_id is not null));

-- Managers can track follow-up tasks on their own campaigns.
create policy manager_read on public.tasks for select to authenticated
  using (campaign_id = any((select public.my_campaign_ids())::text[]));
create policy manager_insert on public.tasks for insert to authenticated
  with check (campaign_id = any((select public.my_campaign_ids())::text[]));
create policy manager_update on public.tasks for update to authenticated
  using (campaign_id = any((select public.my_campaign_ids())::text[]))
  with check (campaign_id = any((select public.my_campaign_ids())::text[]));

-- Everyone can see their own profile and manager links.
create policy own_read on public.profiles      for select to authenticated using (user_id = (select auth.uid()));
create policy own_read on public.user_managers for select to authenticated using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- Reporting views (security_invoker so RLS of the caller applies)
-- ---------------------------------------------------------------------------
-- Matches the AppSheet formulas:
--   Raised   = Payment amounts + Funded on Batch rows + transfers in
--   Fees     = Σ fee (non-voided)
--   Expenses = expenses + transfers out
--   Balance  = Raised - Fees - Expenses
--   Pending  = Σ batch_pending
create or replace view public.campaign_summary with (security_invoker = true) as
with d as (
  select campaign_id,
         sum(case when type = 'Payment' then amount
                  when type = 'Batch'   then coalesce(funded, 0)
                  else 0 end)                                  as donations_raised,
         sum(case when type <> 'Voided' then coalesce(fee, 0) else 0 end) as fees,
         sum(coalesce(batch_pending, 0))                       as pending_balance,
         count(*) filter (where type <> 'Voided')              as donation_count,
         max(created_at)                                       as last_donation_at
  from public.donations group by campaign_id
), e as (
  select campaign_id, sum(amount) as expenses from public.expenses group by campaign_id
), tin as (
  select to_campaign_id as campaign_id, sum(amount) as amt from public.transfers group by to_campaign_id
), tout as (
  select from_campaign_id as campaign_id, sum(amount) as amt from public.transfers group by from_campaign_id
)
select c.*,
       m.full_name                                                  as manager_name,
       coalesce(d.donations_raised, 0) + coalesce(tin.amt, 0)       as raised,
       coalesce(d.fees, 0)                                          as fees,
       case when coalesce(d.donations_raised, 0) + coalesce(tin.amt, 0) = 0 then 0
            else coalesce(d.fees, 0) / (coalesce(d.donations_raised, 0) + coalesce(tin.amt, 0)) end as fee_percent,
       coalesce(e.expenses, 0) + coalesce(tout.amt, 0)              as expenses,
       coalesce(d.donations_raised, 0) + coalesce(tin.amt, 0)
         - coalesce(d.fees, 0) - coalesce(e.expenses, 0) - coalesce(tout.amt, 0) as balance,
       coalesce(d.pending_balance, 0)                               as pending_balance,
       coalesce(d.donation_count, 0)                                as donation_count,
       d.last_donation_at
from public.campaigns c
left join public.managers m on m.id = c.manager_id
left join d    on d.campaign_id    = c.id
left join e    on e.campaign_id    = c.id
left join tin  on tin.campaign_id  = c.id
left join tout on tout.campaign_id = c.id;

create or replace view public.donor_summary with (security_invoker = true) as
select dn.*,
       coalesce(g.gift_count, 0)  as gift_count,
       coalesce(g.total_given, 0) as total_given,
       g.first_gift_at,
       g.last_gift_at,
       g.campaign_count
from public.donors dn
left join (
  select donor_id,
         count(*)                    as gift_count,
         sum(amount)                 as total_given,
         min(created_at)             as first_gift_at,
         max(created_at)             as last_gift_at,
         count(distinct campaign_id) as campaign_count
  from public.donations
  where donor_id is not null and type <> 'Voided'
  group by donor_id
) g on g.donor_id = dn.id;

grant select on public.campaign_summary, public.donor_summary to authenticated;

insert into public.admin_emails (email) values ('smueller@bpjcc.org');
