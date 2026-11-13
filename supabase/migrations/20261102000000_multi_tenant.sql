-- Phase 1: every business record belongs to an organization, and organizations can't see each other.
--
-- Which organization a request belongs to comes from the x-org-id header, set by the app from the
-- URL. The header is only a choice: current_org_id() honours it only for a member (or a Platform
-- Owner with an open, logged session). A restrictive policy on every table then limits all access
-- to that one organization, whatever the other policies say.
--
-- Everything already in the database becomes the first tenant, Oizer Umoshia. The migration fails
-- at the end if any campaign's numbers changed.

create temp table _balances_before as
  select id, raised, fees, expenses, balance, pending_balance from public.campaign_summary;

-- ---------------------------------------------------------------------------
-- Organizations, memberships and the Platform Owner
-- ---------------------------------------------------------------------------
create table public.organizations (
  id            uuid primary key default gen_random_uuid(),
  slug          text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]*$'),
  name          text not null,
  status        text not null default 'active' check (status in ('active','suspended','deactivated')),
  legal_name    text,
  ein           text,
  address       text,
  phone         text,
  email         text,
  zelle         text,
  check_payee   text,
  director_name text,
  logo_url      text,
  primary_color text,
  timezone      text not null default 'America/New_York',
  features      jsonb not null default '{}',   -- feature areas switched off, e.g. {"machines": false}
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create trigger touch_updated_at before update on public.organizations
  for each row execute function public.touch_updated_at();

insert into public.organizations (id, slug, name, legal_name, ein, address, phone, email, zelle, check_payee, director_name)
values ('00000000-0000-4000-8000-000000000001', 'oizer', 'Oizer Umoshia', 'Cong. Oizer', '99-3882592',
        '1360 48th st #C5 Brooklyn, NY 11219', '718-550-7705', 'congoizer@gmail.com', 'congoizer@gmail.com',
        'Cong. Oizer', 'Moshe Henig');

-- The URL decides the organization: each org has one or more hostnames.
create table public.org_domains (
  hostname text primary key check (hostname = lower(hostname)),
  org_id   uuid not null references public.organizations(id) on delete cascade
);
create index on public.org_domains (org_id);
insert into public.org_domains (hostname, org_id)
values ('oizer.trubase.org', '00000000-0000-4000-8000-000000000001');

create table public.org_members (
  org_id     uuid not null references public.organizations(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       text not null default 'pending' check (role in ('admin','manager','pending')),
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index on public.org_members (user_id);

insert into public.org_members (org_id, user_id, role, created_at)
select '00000000-0000-4000-8000-000000000001', user_id, role, created_at from public.profiles;

create table public.platform_owners (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
insert into public.platform_owners (user_id)
select user_id from public.profiles where lower(email) = 'smueller@trubase.org';

-- A Platform Owner can only reach into an organization through one of these, and opening one is
-- written to that organization's own activity log.
create table public.platform_sessions (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  org_id     uuid not null references public.organizations(id) on delete cascade,
  reason     text,
  started_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '4 hours',
  ended_at   timestamptz
);
create index on public.platform_sessions (user_id, org_id);

-- ---------------------------------------------------------------------------
-- org_id on everything; composite keys so campaign IDs and source keys are unique per org and a
-- record can never point at another organization's record.
-- ---------------------------------------------------------------------------
drop view public.manager_summary;
drop view public.account_summary;
drop view public.source_summary;
drop view public.donor_summary;
drop view public.campaign_summary;

-- A default on the new column fills existing rows without touching them, so no triggers fire.
do $$
declare t text;
begin
  foreach t in array array['managers','collectors','donors','accounts','sources','campaigns','donations',
                           'expenses','transfers','pledges','tasks','admin_emails','user_managers','settings',
                           'activity_log','balance_snapshots'] loop
    execute format($f$alter table public.%I add column org_id uuid default '00000000-0000-4000-8000-000000000001'
                      references public.organizations(id)$f$, t);
  end loop;
end $$;

alter table public.campaigns drop constraint campaigns_manager_id_fkey;
alter table public.donations drop constraint donations_campaign_id_fkey;
alter table public.donations drop constraint donations_donor_id_fkey;
alter table public.donations drop constraint donations_collector_id_fkey;
alter table public.donations drop constraint donations_source_fkey;
alter table public.donations drop constraint donations_account_id_fkey;
alter table public.expenses  drop constraint expenses_campaign_id_fkey;
alter table public.expenses  drop constraint expenses_account_id_fkey;
alter table public.transfers drop constraint transfers_from_campaign_id_fkey;
alter table public.transfers drop constraint transfers_to_campaign_id_fkey;
alter table public.pledges   drop constraint pledges_campaign_id_fkey;
alter table public.pledges   drop constraint pledges_donor_id_fkey;
alter table public.tasks     drop constraint tasks_campaign_id_fkey;
alter table public.tasks     drop constraint tasks_donor_id_fkey;
alter table public.user_managers drop constraint user_managers_manager_id_fkey;

do $$
declare t text;
begin
  foreach t in array array['managers','collectors','donors','accounts','sources','campaigns','donations',
                           'expenses','transfers','pledges','tasks'] loop
    execute format('alter table public.%I alter column org_id set not null', t);
    execute format('alter table public.%I drop constraint %I', t, t || '_pkey');
    execute format('alter table public.%I add constraint %I primary key (org_id, id)', t, t || '_pkey');
  end loop;
end $$;

alter table public.admin_emails alter column org_id set not null;
alter table public.admin_emails drop constraint admin_emails_pkey;
alter table public.admin_emails add primary key (org_id, email);

alter table public.settings alter column org_id set not null;
alter table public.settings drop constraint settings_pkey;
alter table public.settings add primary key (org_id, key);

alter table public.user_managers alter column org_id set not null;
alter table public.user_managers drop constraint user_managers_pkey;
alter table public.user_managers add primary key (org_id, user_id, manager_id);

alter table public.balance_snapshots alter column org_id set not null;
alter table public.balance_snapshots drop constraint balance_snapshots_pkey;
alter table public.balance_snapshots add primary key (org_id, label, campaign_id);
alter table public.balance_snapshots alter column org_id drop default;

-- Platform-level events have no organization, so this one may be null.
alter table public.activity_log alter column org_id drop default;

-- Same constraint names as before: the app's embedded queries refer to them.
alter table public.campaigns add constraint campaigns_manager_id_fkey foreign key (org_id, manager_id)
  references public.managers (org_id, id) on delete set null (manager_id);
alter table public.donations add constraint donations_campaign_id_fkey foreign key (org_id, campaign_id)
  references public.campaigns (org_id, id) on update cascade on delete set null (campaign_id);
alter table public.donations add constraint donations_donor_id_fkey foreign key (org_id, donor_id)
  references public.donors (org_id, id) on delete set null (donor_id);
alter table public.donations add constraint donations_collector_id_fkey foreign key (org_id, collector_id)
  references public.collectors (org_id, id) on delete set null (collector_id);
alter table public.donations add constraint donations_source_fkey foreign key (org_id, source)
  references public.sources (org_id, id) on update cascade on delete set null (source);
alter table public.donations add constraint donations_account_id_fkey foreign key (org_id, account_id)
  references public.accounts (org_id, id) on delete set null (account_id);
alter table public.expenses add constraint expenses_campaign_id_fkey foreign key (org_id, campaign_id)
  references public.campaigns (org_id, id) on update cascade on delete set null (campaign_id);
alter table public.expenses add constraint expenses_account_id_fkey foreign key (org_id, account_id)
  references public.accounts (org_id, id) on delete set null (account_id);
alter table public.transfers add constraint transfers_from_campaign_id_fkey foreign key (org_id, from_campaign_id)
  references public.campaigns (org_id, id) on update cascade on delete set null (from_campaign_id);
alter table public.transfers add constraint transfers_to_campaign_id_fkey foreign key (org_id, to_campaign_id)
  references public.campaigns (org_id, id) on update cascade on delete set null (to_campaign_id);
alter table public.pledges add constraint pledges_campaign_id_fkey foreign key (org_id, campaign_id)
  references public.campaigns (org_id, id) on update cascade on delete set null (campaign_id);
alter table public.pledges add constraint pledges_donor_id_fkey foreign key (org_id, donor_id)
  references public.donors (org_id, id) on delete set null (donor_id);
alter table public.tasks add constraint tasks_campaign_id_fkey foreign key (org_id, campaign_id)
  references public.campaigns (org_id, id) on update cascade on delete set null (campaign_id);
alter table public.tasks add constraint tasks_donor_id_fkey foreign key (org_id, donor_id)
  references public.donors (org_id, id) on delete set null (donor_id);
alter table public.user_managers add constraint user_managers_manager_id_fkey foreign key (org_id, manager_id)
  references public.managers (org_id, id) on delete cascade;

create index on public.donations (org_id, created_at desc);
create index on public.activity_log (org_id, created_at desc);
create index on public.user_managers (user_id);

-- ---------------------------------------------------------------------------
-- Who is asking, and for which organization
-- ---------------------------------------------------------------------------
create or replace function public.has_platform_session(p_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.platform_sessions s
    join public.platform_owners o on o.user_id = s.user_id
    where s.user_id = auth.uid() and s.org_id = p_org and s.ended_at is null and s.expires_at > now())
$$;

create or replace function public.current_org_id() returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_org uuid;
  v_header text;
begin
  if v_uid is null then return null; end if;
  begin
    v_header := current_setting('request.headers', true)::jsonb ->> 'x-org-id';
  exception when others then
    v_header := null;
  end;

  if v_header is not null then
    begin
      v_org := v_header::uuid;
    exception when others then
      return null;
    end;
    if public.has_platform_session(v_org) then return v_org; end if;
    if exists (select 1 from public.org_members m
               join public.organizations o on o.id = m.org_id and o.status = 'active'
               where m.user_id = v_uid and m.org_id = v_org) then
      return v_org;
    end if;
    return null;
  end if;

  -- No header: only unambiguous when the login belongs to exactly one active organization.
  select min(m.org_id::text)::uuid into v_org
  from public.org_members m
  join public.organizations o on o.id = m.org_id and o.status = 'active'
  where m.user_id = v_uid
  having count(*) = 1;
  return v_org;
end $$;

-- A Platform Owner in a session acts with an admin's access.
create or replace function public.my_org_role() returns text
language sql stable security definer set search_path = '' as $$
  select case when public.has_platform_session(public.current_org_id()) then 'admin'
              else (select m.role from public.org_members m
                    where m.user_id = auth.uid() and m.org_id = public.current_org_id()) end
$$;

create or replace function public.is_platform_owner() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.platform_owners where user_id = auth.uid())
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(public.my_org_role() = 'admin', false)
$$;

create or replace function public.is_active_user() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(public.my_org_role() in ('admin','manager'), false)
$$;

create or replace function public.my_manager_ids() returns text[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(um.manager_id), '{}')
  from public.user_managers um
  join public.org_members om on om.org_id = um.org_id and om.user_id = um.user_id and om.role = 'manager'
  join public.managers m on m.org_id = um.org_id and m.id = um.manager_id and m.deleted_at is null
  where um.user_id = auth.uid() and um.org_id = public.current_org_id()
$$;

create or replace function public.my_campaign_ids() returns text[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(c.id), '{}')
  from public.campaigns c
  where c.org_id = public.current_org_id()
    and c.deleted_at is null
    and (c.manager_id = any(public.my_manager_ids())
         or c.sub_manager_ids && public.my_manager_ids())
$$;

-- New records land in the organization of the request; anything else fails the not-null check.
do $$
declare t text;
begin
  foreach t in array array['managers','collectors','donors','accounts','sources','campaigns','donations',
                           'expenses','transfers','pledges','tasks','admin_emails','user_managers','settings'] loop
    execute format('alter table public.%I alter column org_id set default public.current_org_id()', t);
  end loop;
end $$;

alter table public.profiles drop column role;

-- ---------------------------------------------------------------------------
-- Sign-ups and access links
-- ---------------------------------------------------------------------------
-- The email decides access in every organization that listed it. org_slug in the sign-up metadata
-- only says which organization's page they signed up on, so its admins can see them as pending.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_slug_org uuid;
begin
  insert into public.profiles (user_id, email, full_name)
  values (new.id, new.email, new.raw_user_meta_data ->> 'full_name');

  insert into public.org_members (org_id, user_id, role)
  select a.org_id, new.id, 'admin' from public.admin_emails a where lower(a.email) = lower(new.email)
  on conflict do nothing;

  insert into public.org_members (org_id, user_id, role)
  select distinct m.org_id, new.id, 'manager' from public.managers m
  where lower(m.email) = lower(new.email) and m.deleted_at is null
  on conflict do nothing;

  insert into public.user_managers (org_id, user_id, manager_id)
  select m.org_id, new.id, m.id
  from public.managers m
  join public.org_members om on om.org_id = m.org_id and om.user_id = new.id and om.role = 'manager'
  where lower(m.email) = lower(new.email) and m.deleted_at is null
  on conflict do nothing;

  select o.id into v_slug_org from public.organizations o
  where o.slug = new.raw_user_meta_data ->> 'org_slug' and o.status = 'active';
  if v_slug_org is not null then
    insert into public.org_members (org_id, user_id, role) values (v_slug_org, new.id, 'pending')
    on conflict do nothing;
  end if;
  return new;
end $$;

-- Someone with a login from another organization gets access as soon as they are listed here.
create or replace function public.link_admin_email() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.org_members (org_id, user_id, role)
  select new.org_id, u.id, 'admin' from auth.users u where lower(u.email) = lower(new.email)
  on conflict (org_id, user_id) do update set role = 'admin';
  return null;
end $$;
create trigger link_admin_email after insert on public.admin_emails
  for each row execute function public.link_admin_email();

create or replace function public.link_manager_email() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.email is null or new.deleted_at is not null then return null; end if;
  insert into public.org_members (org_id, user_id, role)
  select new.org_id, u.id, 'manager' from auth.users u where lower(u.email) = lower(new.email)
  on conflict (org_id, user_id) do update set role = 'manager' where public.org_members.role = 'pending';

  insert into public.user_managers (org_id, user_id, manager_id)
  select new.org_id, u.id, new.id
  from auth.users u
  join public.org_members om on om.org_id = new.org_id and om.user_id = u.id and om.role = 'manager'
  where lower(u.email) = lower(new.email)
  on conflict do nothing;
  return null;
end $$;
create trigger link_manager_email after insert or update of email on public.managers
  for each row execute function public.link_manager_email();

-- ---------------------------------------------------------------------------
-- Soft delete and activity, now per organization
-- ---------------------------------------------------------------------------
create or replace function public.soft_delete() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  execute format('update public.%I set deleted_at = now(), deleted_by = public.current_email()
                  where org_id = $1 and id = $2 and deleted_at is null', tg_table_name) using old.org_id, old.id;
  return null;  -- cancels the real delete
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
  execute format('update public.%I set deleted_at = null, deleted_by = null
                  where org_id = $1 and id = $2 and deleted_at is not null', p_table)
    using public.current_org_id(), p_id;
  get diagnostics v_count = row_count;
  return v_count > 0;
end $$;

drop function public.write_activity(text, text, text, text, jsonb);

create or replace function public.write_activity(
  p_org uuid, p_action text, p_table text, p_record text, p_campaign text, p_changes jsonb
) returns void
language sql security definer set search_path = '' as $$
  insert into public.activity_log (org_id, user_id, user_email, user_role, action, table_name, record_id, campaign_id, changes, ip)
  values (p_org, auth.uid(), public.current_email(),
          case when public.has_platform_session(p_org) then 'platform_owner'
               else (select m.role from public.org_members m where m.user_id = auth.uid() and m.org_id = p_org) end,
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
    coalesce((v_row ->> 'org_id')::uuid,
             case when tg_table_name = 'organizations' then (v_row ->> 'id')::uuid end,
             public.current_org_id()),
    v_action, tg_table_name,
    case when tg_table_name = 'org_members' then v_row ->> 'user_id'
         else coalesce(v_row ->> 'id', v_row ->> 'user_id', v_row ->> 'email', v_row ->> 'key') end,
    coalesce(v_row ->> 'campaign_id', v_row ->> 'from_campaign_id',
             case when tg_table_name = 'campaigns' then v_row ->> 'id' end),
    v_changes);
  return null;
end $$;

create trigger log_row_change after insert or update or delete on public.org_members
  for each row execute function public.log_row_change();
create trigger log_row_change after insert or update or delete on public.organizations
  for each row execute function public.log_row_change();

-- Sign-outs and exports, which happen outside the database, so the app reports them.
create or replace function public.log_activity(p_action text, p_detail jsonb default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;
  if p_action <> all (array['logout','export']) then
    raise exception 'Unknown activity %', p_action;
  end if;
  if pg_column_size(p_detail) > 4096 then
    raise exception 'Activity detail too large';
  end if;
  perform public.write_activity(public.current_org_id(), p_action, null, null, null, p_detail);
end $$;

-- Who signed in and when, written to each organization the login belongs to.
create or replace function public.log_user_event(p_user uuid, p_email text, p_action text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.activity_log (org_id, user_id, user_email, user_role, action)
  select m.org_id, p_user, p_email, m.role, p_action
  from public.org_members m where m.user_id = p_user;
  if not found then
    insert into public.activity_log (user_id, user_email, action) values (p_user, p_email, p_action);
  end if;
exception when others then
  null;  -- this runs inside sign-in; a log failure must never lock anyone out
end $$;

create or replace function public.log_sign_in() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform public.log_user_event(new.id, new.email, 'login');
  return null;
end $$;

-- ---------------------------------------------------------------------------
-- Balance snapshots, per organization (all of them when run by the system)
-- ---------------------------------------------------------------------------
create or replace function public.take_balance_snapshot(p_label text) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_count int;
  v_org uuid := public.current_org_id();
begin
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'Only admins can take balance snapshots';
  end if;
  insert into public.balance_snapshots (org_id, label, campaign_id, raised, fees, expenses, balance, pending_balance)
  select org_id, p_label, id, raised, fees, expenses, balance, pending_balance
  from public.campaign_summary where auth.uid() is null or org_id = v_org;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

create or replace function public.balance_drift(p_label text)
returns table (campaign_id text, snapshot_balance numeric, current_balance numeric, snapshot_raised numeric, current_raised numeric)
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id();
begin
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'Only admins can compare balance snapshots';
  end if;
  return query
    select coalesce(s.campaign_id, c.id), s.balance, c.balance, s.raised, c.raised
    from (select * from public.balance_snapshots b
          where b.label = p_label and (auth.uid() is null or b.org_id = v_org)) s
    full join (select * from public.campaign_summary cs where auth.uid() is null or cs.org_id = v_org) c
      on c.org_id = s.org_id and c.id = s.campaign_id
    where s.raised is distinct from c.raised or s.fees is distinct from c.fees
       or s.expenses is distinct from c.expenses or s.balance is distinct from c.balance
       or s.pending_balance is distinct from c.pending_balance;
end $$;

-- ---------------------------------------------------------------------------
-- Reporting views: every join now also matches the organization
-- ---------------------------------------------------------------------------
create view public.campaign_summary with (security_invoker = true) as
with d as (
  select org_id, campaign_id,
         sum(case when type = 'Payment' then amount
                  when type = 'Batch'   then coalesce(funded, 0)
                  else 0 end)                                  as donations_raised,
         sum(case when type <> 'Voided' then coalesce(fee, 0) else 0 end) as fees,
         sum(coalesce(batch_pending, 0))                       as pending_balance,
         count(*) filter (where type <> 'Voided')              as donation_count,
         max(created_at)                                       as last_donation_at
  from public.donations where deleted_at is null group by org_id, campaign_id
), e as (
  select org_id, campaign_id, sum(amount) as expenses from public.expenses where deleted_at is null group by org_id, campaign_id
), tin as (
  select org_id, to_campaign_id as campaign_id, sum(amount) as amt from public.transfers where deleted_at is null group by org_id, to_campaign_id
), tout as (
  select org_id, from_campaign_id as campaign_id, sum(amount) as amt from public.transfers where deleted_at is null group by org_id, from_campaign_id
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
left join public.managers m on m.org_id = c.org_id and m.id = c.manager_id and m.deleted_at is null
left join d    on d.org_id    = c.org_id and d.campaign_id    = c.id
left join e    on e.org_id    = c.org_id and e.campaign_id    = c.id
left join tin  on tin.org_id  = c.org_id and tin.campaign_id  = c.id
left join tout on tout.org_id = c.org_id and tout.campaign_id = c.id
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
  select org_id, donor_id,
         count(*)                    as gift_count,
         sum(amount)                 as total_given,
         min(created_at)             as first_gift_at,
         max(created_at)             as last_gift_at,
         count(distinct campaign_id) as campaign_count
  from public.donations
  where donor_id is not null and type <> 'Voided' and deleted_at is null
  group by org_id, donor_id
) g on g.org_id = dn.org_id and g.donor_id = dn.id
where dn.deleted_at is null;

create view public.source_summary with (security_invoker = true) as
select s.*,
       coalesce(d.donation_count, 0) as donation_count,
       coalesce(d.total_amount, 0)   as total_amount,
       coalesce(d.total_fees, 0)     as total_fees,
       d.last_donation_at
from public.sources s
left join (
  select org_id, source,
         count(*)                                                as donation_count,
         sum(amount)                                             as total_amount,
         sum(coalesce(fee, 0))                                   as total_fees,
         max(created_at)                                         as last_donation_at
  from public.donations
  where type <> 'Voided' and deleted_at is null
  group by org_id, source
) d on d.org_id = s.org_id and d.source = s.id
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
  select org_id, account_id, count(*) as donation_count, sum(amount) as donations_total
  from public.donations where type <> 'Voided' and deleted_at is null group by org_id, account_id
) d on d.org_id = a.org_id and d.account_id = a.id
left join (
  select org_id, account_id,
         count(*)                                                as expense_count,
         sum(amount)                                             as expenses_total,
         sum(amount) filter (where method = 'Check' and cleared is not true) as uncleared_total
  from public.expenses where deleted_at is null group by org_id, account_id
) e on e.org_id = a.org_id and e.account_id = a.id
where a.deleted_at is null;

create view public.manager_summary with (security_invoker = true) as
select m.*,
       count(c.id)                                     as campaign_count,
       count(c.id) filter (where c.archived_at is null) as active_count,
       coalesce(sum(c.raised), 0)                      as raised,
       coalesce(sum(c.balance), 0)                     as balance
from public.managers m
left join public.campaign_summary c
  on c.org_id = m.org_id and (c.manager_id = m.id or m.id = any(c.sub_manager_ids))
where m.deleted_at is null
group by m.org_id, m.id;

revoke all on public.campaign_summary, public.donor_summary, public.source_summary,
              public.account_summary, public.manager_summary from anon;
grant select on public.campaign_summary, public.donor_summary, public.source_summary,
                public.account_summary, public.manager_summary to authenticated;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
-- The wall between organizations. Restrictive: it applies on top of every other policy.
do $$
declare t text;
begin
  foreach t in array array['managers','collectors','donors','accounts','sources','campaigns','donations',
                           'expenses','transfers','pledges','tasks','admin_emails','user_managers','settings',
                           'activity_log','balance_snapshots'] loop
    execute format('create policy org_wall on public.%I as restrictive for all to authenticated
                    using (org_id = (select public.current_org_id()))
                    with check (org_id = (select public.current_org_id()))', t);
  end loop;
end $$;

alter table public.organizations     enable row level security;
alter table public.org_domains       enable row level security;
alter table public.org_members       enable row level security;
alter table public.platform_owners   enable row level security;
alter table public.platform_sessions enable row level security;

revoke all on public.organizations, public.org_domains, public.org_members,
              public.platform_owners, public.platform_sessions from anon;

-- Name, contact details and branding are the admins'. Status only changes through the Platform Owner.
revoke all on public.organizations from authenticated;
grant select on public.organizations to authenticated;
grant update (name, legal_name, ein, address, phone, email, zelle, check_payee, director_name,
              logo_url, primary_color, timezone, features)
  on public.organizations to authenticated;
create policy member_read on public.organizations for select to authenticated
  using (id = (select public.current_org_id()));
create policy admin_update on public.organizations for update to authenticated
  using (id = (select public.current_org_id()) and (select public.is_admin()))
  with check (id = (select public.current_org_id()) and (select public.is_admin()));

revoke all on public.org_domains from authenticated;
grant select on public.org_domains to authenticated;
create policy admin_read on public.org_domains for select to authenticated
  using (org_id = (select public.current_org_id()) and (select public.is_admin()));

create policy org_wall on public.org_members as restrictive for all to authenticated
  using (org_id = (select public.current_org_id()))
  with check (org_id = (select public.current_org_id()));
create policy admin_all on public.org_members for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
create policy own_read on public.org_members for select to authenticated
  using (user_id = (select auth.uid()));

-- A person's profile is shared between organizations; admins see only their own organization's people.
drop policy admin_all on public.profiles;
revoke insert, update, delete on public.profiles from authenticated, anon;
create policy admin_read on public.profiles for select to authenticated
  using ((select public.is_admin()) and exists (
    select 1 from public.org_members m
    where m.user_id = profiles.user_id and m.org_id = (select public.current_org_id())));

revoke all on public.platform_owners, public.platform_sessions from authenticated;
grant select on public.platform_owners, public.platform_sessions to authenticated;
create policy own_read on public.platform_owners for select to authenticated
  using (user_id = (select auth.uid()));
create policy own_read on public.platform_sessions for select to authenticated
  using (user_id = (select auth.uid()));

-- Job history is about the platform, not any one organization.
drop policy admin_read on public.job_runs;
create policy owner_read on public.job_runs for select to authenticated using ((select public.is_platform_owner()));

-- ---------------------------------------------------------------------------
-- What the app calls
-- ---------------------------------------------------------------------------
-- The login page needs the organization's name before anyone has signed in, so this is public.
-- It returns only what the page itself would show.
create or replace function public.resolve_org(p_host text, p_slug text default null)
returns table (id uuid, slug text, name text, logo_url text, primary_color text, timezone text)
language sql stable security definer set search_path = '' as $$
  select o.id, o.slug, o.name, o.logo_url, o.primary_color, o.timezone
  from public.organizations o
  where o.status = 'active'
    and (o.id in (select d.org_id from public.org_domains d where d.hostname = lower(p_host)) or o.slug = p_slug)
  order by o.slug = p_slug desc nulls last
  limit 1
$$;

-- Everything the app needs to know about the signed-in person, for the organization in the request.
create or replace function public.my_access() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'org_id', public.current_org_id(),
    'role', public.my_org_role(),
    'is_platform_owner', public.is_platform_owner(),
    'in_platform_session', coalesce(public.has_platform_session(public.current_org_id()), false),
    'orgs', (select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'slug', o.slug, 'name', o.name, 'role', m.role) order by o.name), '[]')
             from public.org_members m
             join public.organizations o on o.id = m.org_id and o.status = 'active'
             where m.user_id = auth.uid()))
$$;

create or replace function public.require_platform_owner() returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_platform_owner() then
    raise exception 'Only the Platform Owner can do this';
  end if;
end $$;

create or replace function public.seed_org_settings(p_org uuid) returns void
language sql security definer set search_path = '' as $$
  insert into public.settings (org_id, key, value, description, updated_by) values
    (p_org, 'timezone', '"America/New_York"', 'Time zone for dates, reports and digests', 'system'),
    (p_org, 'duplicate_window_minutes', '10', 'Same donor, amount and campaign within this window is flagged as a possible duplicate', 'system'),
    (p_org, 'inactive_campaign_days', '90', 'Active campaigns with no activity for this long are flagged', 'system'),
    (p_org, 'stale_check_days', '90', 'Outstanding checks older than this are flagged', 'system'),
    (p_org, 'max_phones_per_fundraiser', '3', 'Registered phone numbers allowed per fundraiser', 'system'),
    (p_org, 'auto_receipt', 'false', 'Send receipts automatically unless a campaign overrides it', 'system'),
    (p_org, 'machine_digest_time', '"22:00"', 'When the daily Donary machine summary goes out', 'system')
  on conflict do nothing
$$;

-- Counts only, so the list of organizations doesn't itself read anyone's donor data.
create or replace function public.platform_list_orgs()
returns table (id uuid, slug text, name text, status text, created_at timestamptz, hostnames text[],
               member_count bigint, campaign_count bigint, donor_count bigint, donation_count bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.require_platform_owner();
  return query
    select o.id, o.slug, o.name, o.status, o.created_at,
           (select coalesce(array_agg(d.hostname order by d.hostname), '{}') from public.org_domains d where d.org_id = o.id),
           (select count(*) from public.org_members m where m.org_id = o.id),
           (select count(*) from public.campaigns c where c.org_id = o.id and c.deleted_at is null),
           (select count(*) from public.donors dn where dn.org_id = o.id and dn.deleted_at is null),
           (select count(*) from public.donations dd where dd.org_id = o.id and dd.deleted_at is null)
    from public.organizations o
    order by o.name;
end $$;

create or replace function public.platform_create_org(p_name text, p_slug text, p_admin_email text, p_hostname text default null)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_org uuid;
begin
  perform public.require_platform_owner();
  insert into public.organizations (name, slug) values (trim(p_name), lower(trim(p_slug))) returning id into v_org;
  if nullif(trim(p_hostname), '') is not null then
    insert into public.org_domains (hostname, org_id) values (lower(trim(p_hostname)), v_org);
  end if;
  perform public.seed_org_settings(v_org);
  insert into public.admin_emails (org_id, email) values (v_org, lower(trim(p_admin_email)));
  return v_org;
end $$;

create or replace function public.platform_set_org_status(p_org uuid, p_status text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_platform_owner();
  update public.organizations set status = p_status where id = p_org;
  if not found then raise exception 'Organization not found'; end if;
end $$;

create or replace function public.platform_enter_org(p_org uuid, p_reason text default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_platform_owner();
  if not exists (select 1 from public.organizations where id = p_org) then
    raise exception 'Organization not found';
  end if;
  update public.platform_sessions set ended_at = now()
  where user_id = auth.uid() and ended_at is null;
  insert into public.platform_sessions (user_id, org_id, reason) values (auth.uid(), p_org, p_reason);
  insert into public.activity_log (org_id, user_id, user_email, user_role, action, changes, ip)
  values (p_org, auth.uid(), public.current_email(), 'platform_owner', 'platform_enter',
          jsonb_strip_nulls(jsonb_build_object('reason', p_reason)), public.request_ip());
end $$;

create or replace function public.platform_exit_org() returns void
language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  perform public.require_platform_owner();
  for r in update public.platform_sessions set ended_at = now()
           where user_id = auth.uid() and ended_at is null returning org_id loop
    insert into public.activity_log (org_id, user_id, user_email, user_role, action, ip)
    values (r.org_id, auth.uid(), public.current_email(), 'platform_owner', 'platform_exit', public.request_ip());
  end loop;
end $$;

-- Internal helpers: not callable over the API.
revoke execute on function public.write_activity(uuid, text, text, text, text, jsonb) from public, anon, authenticated;
revoke execute on function public.log_user_event(uuid, text, text) from public, anon, authenticated;
revoke execute on function public.link_admin_email()      from public, anon, authenticated;
revoke execute on function public.link_manager_email()    from public, anon, authenticated;
revoke execute on function public.seed_org_settings(uuid) from public, anon, authenticated;
revoke execute on function public.require_platform_owner() from public, anon, authenticated;

-- Signed-in only.
revoke execute on function public.has_platform_session(uuid) from public, anon;
revoke execute on function public.current_org_id()      from public, anon;
revoke execute on function public.my_org_role()         from public, anon;
revoke execute on function public.is_platform_owner()   from public, anon;
revoke execute on function public.my_access()           from public, anon;
revoke execute on function public.platform_list_orgs()  from public, anon;
revoke execute on function public.platform_create_org(text, text, text, text) from public, anon;
revoke execute on function public.platform_set_org_status(uuid, text) from public, anon;
revoke execute on function public.platform_enter_org(uuid, text) from public, anon;
revoke execute on function public.platform_exit_org()   from public, anon;
grant execute on function public.has_platform_session(uuid) to authenticated;
grant execute on function public.current_org_id()      to authenticated, service_role;
grant execute on function public.my_org_role()         to authenticated;
grant execute on function public.is_platform_owner()   to authenticated;
grant execute on function public.my_access()           to authenticated;
grant execute on function public.platform_list_orgs()  to authenticated;
grant execute on function public.platform_create_org(text, text, text, text) to authenticated;
grant execute on function public.platform_set_org_status(uuid, text) to authenticated;
grant execute on function public.platform_enter_org(uuid, text) to authenticated;
grant execute on function public.platform_exit_org()   to authenticated;

-- Public: the login page.
grant execute on function public.resolve_org(text, text) to anon, authenticated;

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
    raise exception 'Multi-tenant migration changed the balance of % campaign(s)', v_moved;
  end if;
end $$;

drop table _balances_before;
