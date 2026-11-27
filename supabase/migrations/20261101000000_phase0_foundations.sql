-- Phase 0 foundations: soft delete, append-only activity log, settings and balance snapshots.
-- Nothing is hard-deleted from the business tables after this runs. Balances must not move:
-- the migration fails at the end if any campaign's numbers changed.

create temp table _balances_before as
  select id, raised, fees, expenses, balance, pending_balance from public.campaign_summary;

-- ---------------------------------------------------------------------------
-- Soft delete
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['managers','collectors','donors','accounts','sources','campaigns','donations',
                           'expenses','transfers','pledges','tasks'] loop
    execute format('alter table public.%I add column deleted_at timestamptz, add column deleted_by text', t);
  end loop;
end $$;

-- Security definer so the update isn't blocked by the policies that hide deleted rows.
create or replace function public.soft_delete() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  execute format('update public.%I set deleted_at = now(), deleted_by = public.current_email()
                  where id = $1 and deleted_at is null', tg_table_name) using old.id;
  return null;  -- cancels the real delete
end $$;

-- Only admins (or the system, with no signed-in user) can change the deleted columns.
create or replace function public.guard_deleted_columns() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (new.deleted_at is distinct from old.deleted_at or new.deleted_by is distinct from old.deleted_by)
     and auth.uid() is not null and not public.is_admin() then
    raise exception 'Only admins can delete or restore records';
  end if;
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['managers','collectors','donors','accounts','sources','campaigns','donations',
                           'expenses','transfers','pledges','tasks'] loop
    execute format('create trigger soft_delete before delete on public.%I for each row execute function public.soft_delete()', t);
    execute format('create trigger guard_deleted_columns before update on public.%I for each row execute function public.guard_deleted_columns()', t);
    execute format('create policy hide_deleted on public.%I as restrictive for select to authenticated using (deleted_at is null)', t);
  end loop;
end $$;

-- A deleted manager used to lose access through the cascade on user_managers; keep that behaviour.
create or replace function public.my_manager_ids() returns text[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(um.manager_id), '{}')
  from public.user_managers um
  join public.profiles p on p.user_id = um.user_id and p.role = 'manager'
  join public.managers m on m.id = um.manager_id and m.deleted_at is null
  where um.user_id = auth.uid()
$$;

create or replace function public.my_campaign_ids() returns text[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(c.id), '{}')
  from public.campaigns c
  where c.deleted_at is null
    and (c.manager_id = any(public.my_manager_ids())
         or c.sub_manager_ids && public.my_manager_ids())
$$;

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_role text := 'pending';
begin
  if exists (select 1 from public.admin_emails where lower(email) = lower(new.email)) then
    v_role := 'admin';
  elsif exists (select 1 from public.managers where lower(email) = lower(new.email) and deleted_at is null) then
    v_role := 'manager';
  end if;

  insert into public.profiles (user_id, email, full_name, role)
  values (new.id, new.email, new.raw_user_meta_data ->> 'full_name', v_role);

  if v_role = 'manager' then
    insert into public.user_managers (user_id, manager_id)
    select new.id, m.id from public.managers m where lower(m.email) = lower(new.email) and m.deleted_at is null
    on conflict do nothing;
  end if;
  return new;
end $$;

create or replace function public.restore_record(p_table text, p_id text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_count int;
begin
  if not public.is_admin() then
    raise exception 'Only admins can restore records';
  end if;
  if p_table <> all (array['managers','collectors','donors','accounts','sources','campaigns','donations',
                           'expenses','transfers','pledges','tasks']) then
    raise exception 'Cannot restore records in %', p_table;
  end if;
  execute format('update public.%I set deleted_at = null, deleted_by = null where id = $1 and deleted_at is not null', p_table)
    using p_id;
  get diagnostics v_count = row_count;
  return v_count > 0;
end $$;

-- ---------------------------------------------------------------------------
-- Reporting views: filter deleted rows explicitly, because the service role and
-- security-definer functions bypass the hide_deleted policies.
-- ---------------------------------------------------------------------------
drop view public.manager_summary;
drop view public.account_summary;
drop view public.source_summary;
drop view public.donor_summary;
drop view public.campaign_summary;

create view public.campaign_summary with (security_invoker = true) as
with d as (
  select campaign_id,
         sum(case when type = 'Payment' then amount
                  when type = 'Batch'   then coalesce(funded, 0)
                  else 0 end)                                  as donations_raised,
         sum(case when type <> 'Voided' then coalesce(fee, 0) else 0 end) as fees,
         sum(coalesce(batch_pending, 0))                       as pending_balance,
         count(*) filter (where type <> 'Voided')              as donation_count,
         max(created_at)                                       as last_donation_at
  from public.donations where deleted_at is null group by campaign_id
), e as (
  select campaign_id, sum(amount) as expenses from public.expenses where deleted_at is null group by campaign_id
), tin as (
  select to_campaign_id as campaign_id, sum(amount) as amt from public.transfers where deleted_at is null group by to_campaign_id
), tout as (
  select from_campaign_id as campaign_id, sum(amount) as amt from public.transfers where deleted_at is null group by from_campaign_id
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
left join public.managers m on m.id = c.manager_id and m.deleted_at is null
left join d    on d.campaign_id    = c.id
left join e    on e.campaign_id    = c.id
left join tin  on tin.campaign_id  = c.id
left join tout on tout.campaign_id = c.id
where c.deleted_at is null;

create view public.donor_summary with (security_invoker = true) as
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
  where donor_id is not null and type <> 'Voided' and deleted_at is null
  group by donor_id
) g on g.donor_id = dn.id
where dn.deleted_at is null;

create view public.source_summary with (security_invoker = true) as
select s.*,
       coalesce(d.donation_count, 0) as donation_count,
       coalesce(d.total_amount, 0)   as total_amount,
       coalesce(d.total_fees, 0)     as total_fees,
       d.last_donation_at
from public.sources s
left join (
  select source,
         count(*)                                                as donation_count,
         sum(amount)                                             as total_amount,
         sum(coalesce(fee, 0))                                   as total_fees,
         max(created_at)                                         as last_donation_at
  from public.donations
  where type <> 'Voided' and deleted_at is null
  group by source
) d on d.source = s.id
where s.deleted_at is null;

create view public.account_summary with (security_invoker = true) as
select a.*,
       coalesce(d.donation_count, 0) as donation_count,
       coalesce(d.donations_total, 0) as donations_total,
       coalesce(e.expense_count, 0)  as expense_count,
       coalesce(e.expenses_total, 0) as expenses_total,
       coalesce(e.uncleared_total, 0) as uncleared_total
from public.accounts a
left join (
  select account_id, count(*) as donation_count, sum(amount) as donations_total
  from public.donations where type <> 'Voided' and deleted_at is null group by account_id
) d on d.account_id = a.id
left join (
  select account_id,
         count(*)                                                as expense_count,
         sum(amount)                                             as expenses_total,
         sum(amount) filter (where method = 'Check' and cleared is not true) as uncleared_total
  from public.expenses where deleted_at is null group by account_id
) e on e.account_id = a.id
where a.deleted_at is null;

create view public.manager_summary with (security_invoker = true) as
select m.*,
       count(c.id)                                     as campaign_count,
       count(c.id) filter (where c.archived_at is null) as active_count,
       coalesce(sum(c.raised), 0)                      as raised,
       coalesce(sum(c.balance), 0)                     as balance
from public.managers m
left join public.campaign_summary c
  on c.manager_id = m.id or m.id = any(c.sub_manager_ids)
where m.deleted_at is null
group by m.id;

revoke all on public.campaign_summary, public.donor_summary, public.source_summary,
              public.account_summary, public.manager_summary from anon;
grant select on public.campaign_summary, public.donor_summary, public.source_summary,
                public.account_summary, public.manager_summary to authenticated;

-- ---------------------------------------------------------------------------
-- Activity log (append-only)
-- ---------------------------------------------------------------------------
create table public.activity_log (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  user_id     uuid,                -- no foreign key: entries outlive the login
  user_email  text,
  user_role   text,
  action      text not null,
  table_name  text,
  record_id   text,
  campaign_id text,
  changes     jsonb,
  ip          text
);
create index on public.activity_log (created_at desc);
create index on public.activity_log (table_name, record_id);
create index on public.activity_log (campaign_id);
create index on public.activity_log (user_id);

alter table public.activity_log enable row level security;
revoke all on public.activity_log from anon, authenticated, service_role;
grant select on public.activity_log to authenticated, service_role;
create policy admin_read on public.activity_log for select to authenticated using ((select public.is_admin()));

create or replace function public.reject_activity_change() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'The activity log is append-only';
end $$;
create trigger append_only before update or delete on public.activity_log
  for each row execute function public.reject_activity_change();
create trigger append_only_truncate before truncate on public.activity_log
  for each statement execute function public.reject_activity_change();

-- A log failure must never block a donation from saving, so bad headers just mean no IP.
create or replace function public.request_ip() returns text
language plpgsql stable set search_path = '' as $$
begin
  return nullif(trim(split_part(current_setting('request.headers', true)::jsonb ->> 'x-forwarded-for', ',', 1)), '');
exception when others then
  return null;
end $$;

create or replace function public.write_activity(
  p_action text, p_table text, p_record text, p_campaign text, p_changes jsonb
) returns void
language sql security definer set search_path = '' as $$
  insert into public.activity_log (user_id, user_email, user_role, action, table_name, record_id, campaign_id, changes, ip)
  values (auth.uid(), public.current_email(),
          (select role from public.profiles where user_id = auth.uid()),
          p_action, p_table, p_record, p_campaign, p_changes, public.request_ip())
$$;

create or replace function public.log_row_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_old jsonb;
  v_new jsonb;
  v_row jsonb;
  v_changes jsonb;
  v_action text := lower(tg_op);
begin
  if tg_op <> 'INSERT' then v_old := to_jsonb(old); end if;
  if tg_op <> 'DELETE' then v_new := to_jsonb(new); end if;
  v_row := coalesce(v_new, v_old);

  if tg_op = 'UPDATE' then
    select jsonb_object_agg(n.key, jsonb_build_object('old', o.value, 'new', n.value))
      into v_changes
      from jsonb_each(v_new) n
      join jsonb_each(v_old) o on o.key = n.key
     where n.value is distinct from o.value and n.key <> 'updated_at';
    if v_changes is null then return null; end if;
    if v_old ->> 'deleted_at' is null and v_new ->> 'deleted_at' is not null then
      v_action := 'soft_delete';
    elsif v_old ->> 'deleted_at' is not null and v_new ->> 'deleted_at' is null then
      v_action := 'restore';
    end if;
  else
    v_changes := jsonb_strip_nulls(v_row);
  end if;

  perform public.write_activity(
    v_action, tg_table_name,
    coalesce(v_row ->> 'id', v_row ->> 'user_id', v_row ->> 'email', v_row ->> 'key'),
    coalesce(v_row ->> 'campaign_id', v_row ->> 'from_campaign_id',
             case when tg_table_name = 'campaigns' then v_row ->> 'id' end),
    v_changes);
  return null;
end $$;

-- Sign-ins, sign-outs and exports happen outside the database, so the app reports them.
-- The actor always comes from the caller's token, never from the arguments.
create or replace function public.log_activity(p_action text, p_detail jsonb default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;
  if p_action <> all (array['login','logout','export']) then
    raise exception 'Unknown activity %', p_action;
  end if;
  if pg_column_size(p_detail) > 4096 then
    raise exception 'Activity detail too large';
  end if;
  perform public.write_activity(p_action, null, null, null, p_detail);
end $$;

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------
create table public.settings (
  key         text primary key,
  value       jsonb not null,
  description text,
  updated_by  text default public.current_email(),
  updated_at  timestamptz not null default now()
);
alter table public.settings enable row level security;
revoke all on public.settings from anon;
create policy admin_all on public.settings for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
create policy active_read on public.settings for select to authenticated using ((select public.is_active_user()));
create trigger touch_updated_at before update on public.settings
  for each row execute function public.touch_updated_at();

insert into public.settings (key, value, description) values
  ('timezone', '"America/New_York"', 'Time zone for dates, reports and digests'),
  ('duplicate_window_minutes', '10', 'Same donor, amount and campaign within this window is flagged as a possible duplicate'),
  ('inactive_campaign_days', '90', 'Active campaigns with no activity for this long are flagged'),
  ('stale_check_days', '90', 'Outstanding checks older than this are flagged'),
  ('max_phones_per_fundraiser', '3', 'Registered phone numbers allowed per fundraiser'),
  ('auto_receipt', 'false', 'Send receipts automatically unless a campaign overrides it'),
  ('machine_digest_time', '"22:00"', 'When the daily Donary machine summary goes out');

-- Log every business and access table. Created after the settings seed so it isn't logged as a change.
do $$
declare t text;
begin
  foreach t in array array['managers','collectors','donors','accounts','sources','campaigns','donations',
                           'expenses','transfers','pledges','tasks','profiles','user_managers','admin_emails','settings'] loop
    execute format('create trigger log_row_change after insert or update or delete on public.%I for each row execute function public.log_row_change()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Balance snapshots: compare every campaign before and after a risky migration.
-- ---------------------------------------------------------------------------
create table public.balance_snapshots (
  label           text not null,
  campaign_id     text not null,
  taken_at        timestamptz not null default now(),
  raised          numeric not null,
  fees            numeric not null,
  expenses        numeric not null,
  balance         numeric not null,
  pending_balance numeric not null,
  primary key (label, campaign_id)
);
alter table public.balance_snapshots enable row level security;
revoke all on public.balance_snapshots from anon, authenticated;
grant select on public.balance_snapshots to authenticated;
create policy admin_read on public.balance_snapshots for select to authenticated using ((select public.is_admin()));

create or replace function public.take_balance_snapshot(p_label text) returns integer
language plpgsql security definer set search_path = '' as $$
declare v_count int;
begin
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'Only admins can take balance snapshots';
  end if;
  insert into public.balance_snapshots (label, campaign_id, raised, fees, expenses, balance, pending_balance)
  select p_label, id, raised, fees, expenses, balance, pending_balance from public.campaign_summary;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- Campaigns whose numbers differ from the snapshot. Empty means nothing moved.
create or replace function public.balance_drift(p_label text)
returns table (campaign_id text, snapshot_balance numeric, current_balance numeric, snapshot_raised numeric, current_raised numeric)
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'Only admins can compare balance snapshots';
  end if;
  return query
    select coalesce(s.campaign_id, c.id), s.balance, c.balance, s.raised, c.raised
    from (select * from public.balance_snapshots b where b.label = p_label) s
    full join public.campaign_summary c on c.id = s.campaign_id
    where s.raised is distinct from c.raised or s.fees is distinct from c.fees
       or s.expenses is distinct from c.expenses or s.balance is distinct from c.balance
       or s.pending_balance is distinct from c.pending_balance;
end $$;

-- ---------------------------------------------------------------------------
-- Function access
-- ---------------------------------------------------------------------------
revoke execute on function public.soft_delete()            from public, anon, authenticated;
revoke execute on function public.guard_deleted_columns()  from public, anon, authenticated;
revoke execute on function public.reject_activity_change() from public, anon, authenticated;
revoke execute on function public.log_row_change()         from public, anon, authenticated;
revoke execute on function public.request_ip()             from public, anon, authenticated;
revoke execute on function public.write_activity(text, text, text, text, jsonb) from public, anon, authenticated;
revoke execute on function public.restore_record(text, text)    from public, anon;
revoke execute on function public.log_activity(text, jsonb)     from public, anon;
revoke execute on function public.take_balance_snapshot(text)   from public, anon;
revoke execute on function public.balance_drift(text)           from public, anon;
grant execute on function public.restore_record(text, text)    to authenticated;
grant execute on function public.log_activity(text, jsonb)     to authenticated;
grant execute on function public.take_balance_snapshot(text)   to authenticated;
grant execute on function public.balance_drift(text)           to authenticated;

-- ---------------------------------------------------------------------------
-- Stop here if any campaign's numbers moved.
-- ---------------------------------------------------------------------------
do $$
declare v_moved int;
begin
  select count(*) into v_moved
  from _balances_before b
  full join public.campaign_summary c on c.id = b.id
  where b.raised is distinct from c.raised or b.fees is distinct from c.fees
     or b.expenses is distinct from c.expenses or b.balance is distinct from c.balance
     or b.pending_balance is distinct from c.pending_balance;
  if v_moved > 0 then
    raise exception 'Phase 0 migration changed the balance of % campaign(s)', v_moved;
  end if;
end $$;

drop table _balances_before;
