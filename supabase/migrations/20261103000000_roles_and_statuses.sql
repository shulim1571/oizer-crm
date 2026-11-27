-- Phase 2: the spec's roles, transaction statuses and campaign statuses.
--
-- In the database a fundraiser is still a "manager": manager_id is the Primary Fundraiser and
-- sub_manager_ids the Secondaries. The screens use the spec's words. The migration fails at the end
-- if any campaign's numbers changed.

create temp table _balances_before as
  select org_id, id, raised, fees, expenses, balance, pending_balance from public.campaign_summary;

drop view public.manager_summary;
drop view public.account_summary;
drop view public.source_summary;
drop view public.donor_summary;
drop view public.campaign_summary;

-- ---------------------------------------------------------------------------
-- Transaction status. type now only says what kind of record it is.
-- ---------------------------------------------------------------------------
alter table public.donations add column status text not null default 'completed'
  check (status in ('completed','pending','collect','voided','refunded','returned','failed'));

-- This is a change of model, not an edit: no log entries, and Last Update stays as it was.
alter table public.donations disable trigger user;
update public.donations set status = 'collect', type = 'Payment' where type = 'Collect';
update public.donations set status = 'voided', type = case when is_batch then 'Batch' else 'Payment' end where type = 'Voided';
alter table public.donations enable trigger user;

alter table public.donations drop constraint donations_type_check;
alter table public.donations add constraint donations_type_check check (type in ('Payment','Batch'));
create index on public.donations (org_id, status);

-- ---------------------------------------------------------------------------
-- Campaign names and status
-- ---------------------------------------------------------------------------
alter table public.campaigns rename column real_name to internal_name;
alter table public.campaigns rename column friendly_name to external_name;
alter table public.campaigns
  add column status text not null default 'active' check (status in ('draft','active','archived','closed')),
  add column featured boolean not null default false,
  add column closed_at timestamptz;

alter table public.campaigns disable trigger user;
update public.campaigns set status = 'archived' where archived_at is not null;
update public.campaigns set
  internal_name = coalesce(internal_name, campaign_name, external_name, id),
  external_name = coalesce(external_name, campaign_name, internal_name, id)
where internal_name is null or external_name is null;
alter table public.campaigns enable trigger user;

alter table public.campaigns alter column internal_name set not null;
alter table public.campaigns alter column external_name set not null;

-- ---------------------------------------------------------------------------
-- Members: Super Admin, Community Guest, suspension
-- ---------------------------------------------------------------------------
alter table public.org_members drop constraint org_members_role_check;
alter table public.org_members add constraint org_members_role_check
  check (role in ('super_admin','admin','manager','guest','pending'));
alter table public.org_members
  add column status text not null default 'active' check (status in ('active','suspended','deactivated')),
  add column status_reason text,
  add column status_by text,
  add column status_at timestamptz,
  add column last_login_at timestamptz;

-- One Super Admin per organization: the existing owner where there is one, otherwise the oldest admin.
update public.org_members m set role = 'super_admin'
where m.user_id = (
  select a.user_id from public.org_members a
  left join public.profiles p on p.user_id = a.user_id
  where a.org_id = m.org_id and a.role = 'admin'
  order by lower(p.email) = 'smueller@trubase.org' desc, a.created_at, a.user_id
  limit 1);
create unique index org_members_one_super_admin on public.org_members (org_id) where role = 'super_admin';

update public.org_members m set last_login_at = u.last_sign_in_at
from auth.users u where u.id = m.user_id;

-- Fundraisers can have a record without a login, so their status lives on the record too.
alter table public.managers
  add column status text not null default 'active' check (status in ('active','suspended','deactivated')),
  add column status_reason text,
  add column status_by text,
  add column status_at timestamptz;

create table public.admin_delegations (
  org_id     uuid not null default public.current_org_id() references public.organizations(id),
  user_id    uuid not null references auth.users(id) on delete cascade,
  permission text not null check (permission in ('manage_admins','grant_overrides','manage_api_keys','run_imports',
                                                 'change_default_bank','configure_fees','reverse_imports','reopen_campaigns')),
  granted_by text not null default public.current_email(),
  granted_at timestamptz not null default now(),
  primary key (org_id, user_id, permission)
);

-- Campaign-scoped when campaign_ids is set, across all their campaigns when it's null.
create table public.fundraiser_overrides (
  id           text primary key default public.short_id(),
  org_id       uuid not null default public.current_org_id() references public.organizations(id),
  manager_id   text not null,
  permission   text not null check (permission in ('enter_manual_payments','view_donors_beyond','request_payouts','payout_visibility',
                                                   'view_fee_breakdown','source_reports','bulk_receipts','custom_fields')),
  campaign_ids text[],
  granted_by   text not null default public.current_email(),
  granted_at   timestamptz not null default now(),
  revoked_by   text,
  revoked_at   timestamptz,
  foreign key (org_id, manager_id) references public.managers (org_id, id)
);
create unique index fundraiser_overrides_active on public.fundraiser_overrides (org_id, manager_id, permission) where revoked_at is null;

-- Listed by email so a guest can be added before they have a login.
create table public.campaign_guests (
  org_id      uuid not null default public.current_org_id() references public.organizations(id),
  campaign_id text not null,
  email       text not null check (email = lower(email)),
  added_by    text not null default public.current_email(),
  added_at    timestamptz not null default now(),
  primary key (org_id, campaign_id, email),
  foreign key (org_id, campaign_id) references public.campaigns (org_id, id) on update cascade
);
create index on public.campaign_guests (email);

-- ---------------------------------------------------------------------------
-- Who may do what
-- ---------------------------------------------------------------------------
create or replace function public.my_org_role() returns text
language sql stable security definer set search_path = '' as $$
  select case when public.has_platform_session(public.current_org_id()) then 'super_admin'
              else (select m.role from public.org_members m
                    where m.user_id = auth.uid() and m.org_id = public.current_org_id() and m.status = 'active') end
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(public.my_org_role() in ('super_admin','admin'), false)
$$;

create or replace function public.is_active_user() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(public.my_org_role() in ('super_admin','admin','manager'), false)
$$;

create or replace function public.is_super_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(public.my_org_role() = 'super_admin', false)
$$;

create or replace function public.has_super_permission(p_permission text) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_super_admin() or (public.is_admin() and exists (
    select 1 from public.admin_delegations d
    where d.org_id = public.current_org_id() and d.user_id = auth.uid() and d.permission = p_permission))
$$;

create or replace function public.my_manager_ids() returns text[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(um.manager_id), '{}')
  from public.user_managers um
  join public.org_members om on om.org_id = um.org_id and om.user_id = um.user_id
                            and om.role = 'manager' and om.status = 'active'
  join public.managers m on m.org_id = um.org_id and m.id = um.manager_id
                        and m.deleted_at is null and m.status = 'active'
  where um.user_id = auth.uid() and um.org_id = public.current_org_id()
$$;

create or replace function public.my_guest_campaign_ids() returns text[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(g.campaign_id), '{}')
  from public.campaign_guests g
  join public.profiles p on lower(p.email) = g.email and p.user_id = auth.uid()
  join public.org_members m on m.org_id = g.org_id and m.user_id = p.user_id and m.status = 'active'
  join public.campaigns c on c.org_id = g.org_id and c.id = g.campaign_id and c.deleted_at is null
  where g.org_id = public.current_org_id()
$$;

-- A Primary Fundraiser's own campaigns, for the things Secondaries can't do.
create or replace function public.is_primary_on(p_campaign text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.campaigns c
                 where c.org_id = public.current_org_id() and c.id = p_campaign and c.manager_id = any(public.my_manager_ids()))
$$;

-- Overrides only ever add to a fundraiser's role.
create or replace function public.has_override(p_permission text, p_campaign text default null) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.fundraiser_overrides o
                 where o.org_id = public.current_org_id() and o.manager_id = any(public.my_manager_ids())
                   and o.permission = p_permission and o.revoked_at is null
                   and (o.campaign_ids is null or p_campaign = any(o.campaign_ids)))
$$;

-- Admin accounts belong to the Super Admin, or to someone they delegated that to.
create or replace function public.guard_org_member() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_old text;
  v_new text;
begin
  if tg_op <> 'INSERT' then v_old := old.role; end if;
  if tg_op <> 'DELETE' then v_new := new.role; end if;
  if auth.uid() is not null and not public.is_platform_owner()
     and coalesce(current_setting('app.transfer_super_admin', true), '') <> 'on' then
    if v_old = 'super_admin' or v_new = 'super_admin' then
      if not public.is_super_admin() then
        raise exception 'Only the Super Admin can change the Super Admin';
      end if;
      if v_old = 'super_admin' and (v_new is distinct from 'super_admin' or new.status <> 'active') then
        raise exception 'The Super Admin can only be changed by transferring the role';
      end if;
    elsif v_old = 'admin' or v_new = 'admin' then
      if not public.has_super_permission('manage_admins') then
        raise exception 'Only the Super Admin can change admin accounts';
      end if;
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
create trigger guard_org_member before insert or update or delete on public.org_members
  for each row execute function public.guard_org_member();

create or replace function public.transfer_super_admin(p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id();
begin
  if not public.is_super_admin() then
    raise exception 'Only the Super Admin can transfer the role';
  end if;
  if not exists (select 1 from public.org_members m where m.org_id = v_org and m.user_id = p_user and m.status = 'active') then
    raise exception 'That login is not an active member of this organization';
  end if;
  perform set_config('app.transfer_super_admin', 'on', true);
  update public.org_members set role = 'admin' where org_id = v_org and role = 'super_admin';
  update public.org_members set role = 'super_admin' where org_id = v_org and user_id = p_user;
  perform set_config('app.transfer_super_admin', 'off', true);
end $$;

create or replace function public.set_delegation(p_user uuid, p_permission text, p_on boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_super_admin() then
    raise exception 'Only the Super Admin can delegate permissions';
  end if;
  if not exists (select 1 from public.org_members m
                 where m.org_id = public.current_org_id() and m.user_id = p_user and m.role = 'admin') then
    raise exception 'Permissions can only be delegated to an admin of this organization';
  end if;
  if p_on then
    insert into public.admin_delegations (org_id, user_id, permission)
    values (public.current_org_id(), p_user, p_permission) on conflict do nothing;
  else
    delete from public.admin_delegations
    where org_id = public.current_org_id() and user_id = p_user and permission = p_permission;
  end if;
end $$;

create or replace function public.grant_override(p_manager text, p_permission text, p_campaigns text[] default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.has_super_permission('grant_overrides') then
    raise exception 'Only the Super Admin can grant permission overrides';
  end if;
  update public.fundraiser_overrides set revoked_at = now(), revoked_by = public.current_email()
  where org_id = public.current_org_id() and manager_id = p_manager and permission = p_permission and revoked_at is null;
  insert into public.fundraiser_overrides (org_id, manager_id, permission, campaign_ids)
  values (public.current_org_id(), p_manager, p_permission, p_campaigns);
end $$;

-- Any admin can take an override away.
create or replace function public.revoke_override(p_manager text, p_permission text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then
    raise exception 'Only admins can revoke permission overrides';
  end if;
  update public.fundraiser_overrides set revoked_at = now(), revoked_by = public.current_email()
  where org_id = public.current_org_id() and manager_id = p_manager and permission = p_permission and revoked_at is null;
end $$;

-- Suspended: temporary. Deactivated: they've left. Either way access stops at once, and their
-- campaigns and records stay as they are.
create or replace function public.set_fundraiser_status(p_manager text, p_status text, p_reason text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id();
begin
  if not public.is_admin() then
    raise exception 'Only admins can change a fundraiser''s status';
  end if;
  update public.managers
  set status = p_status, status_reason = p_reason, status_by = public.current_email(), status_at = now()
  where org_id = v_org and id = p_manager and deleted_at is null;
  if not found then raise exception 'Fundraiser not found'; end if;
  update public.org_members m
  set status = p_status, status_reason = p_reason, status_by = public.current_email(), status_at = now()
  from public.user_managers um
  where um.org_id = v_org and um.manager_id = p_manager and m.org_id = v_org and m.user_id = um.user_id and m.role = 'manager';
end $$;

create or replace function public.set_member_status(p_user uuid, p_status text, p_reason text default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then
    raise exception 'Only admins can change a login''s status';
  end if;
  if p_user = auth.uid() then
    raise exception 'You can''t change your own status';
  end if;
  update public.org_members
  set status = p_status, status_reason = p_reason, status_by = public.current_email(), status_at = now()
  where org_id = public.current_org_id() and user_id = p_user;
  if not found then raise exception 'Login not found'; end if;
end $$;

-- ---------------------------------------------------------------------------
-- Access links: the first admin of an organization becomes its Super Admin
-- ---------------------------------------------------------------------------
create or replace function public.admin_role_for(p_org uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case when exists (select 1 from public.org_members m where m.org_id = p_org and m.role = 'super_admin')
              then 'admin' else 'super_admin' end
$$;

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_slug_org uuid;
  r record;
begin
  insert into public.profiles (user_id, email, full_name)
  values (new.id, new.email, new.raw_user_meta_data ->> 'full_name');

  for r in select a.org_id from public.admin_emails a where lower(a.email) = lower(new.email) loop
    insert into public.org_members (org_id, user_id, role)
    values (r.org_id, new.id, public.admin_role_for(r.org_id))
    on conflict do nothing;
  end loop;

  insert into public.org_members (org_id, user_id, role)
  select distinct m.org_id, new.id, 'manager' from public.managers m
  where lower(m.email) = lower(new.email) and m.deleted_at is null and m.status <> 'deactivated'
  on conflict do nothing;

  insert into public.user_managers (org_id, user_id, manager_id)
  select m.org_id, new.id, m.id
  from public.managers m
  join public.org_members om on om.org_id = m.org_id and om.user_id = new.id and om.role = 'manager'
  where lower(m.email) = lower(new.email) and m.deleted_at is null and m.status <> 'deactivated'
  on conflict do nothing;

  insert into public.org_members (org_id, user_id, role)
  select distinct g.org_id, new.id, 'guest' from public.campaign_guests g where g.email = lower(new.email)
  on conflict do nothing;

  select o.id into v_slug_org from public.organizations o
  where o.slug = new.raw_user_meta_data ->> 'org_slug' and o.status = 'active';
  if v_slug_org is not null then
    insert into public.org_members (org_id, user_id, role) values (v_slug_org, new.id, 'pending')
    on conflict do nothing;
  end if;
  return new;
end $$;

create or replace function public.link_admin_email() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.org_members (org_id, user_id, role)
  select new.org_id, u.id, public.admin_role_for(new.org_id) from auth.users u where lower(u.email) = lower(new.email)
  on conflict (org_id, user_id) do update set role = 'admin'
    where public.org_members.role <> 'super_admin';
  return null;
end $$;

create or replace function public.link_manager_email() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.email is null or new.deleted_at is not null then return null; end if;
  insert into public.org_members (org_id, user_id, role)
  select new.org_id, u.id, 'manager' from auth.users u where lower(u.email) = lower(new.email)
  on conflict (org_id, user_id) do update set role = 'manager' where public.org_members.role in ('pending','guest');

  insert into public.user_managers (org_id, user_id, manager_id)
  select new.org_id, u.id, new.id
  from auth.users u
  join public.org_members om on om.org_id = new.org_id and om.user_id = u.id and om.role = 'manager'
  where lower(u.email) = lower(new.email)
  on conflict do nothing;
  return null;
end $$;

create or replace function public.link_campaign_guest() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.org_members (org_id, user_id, role)
  select new.org_id, u.id, 'guest' from auth.users u where lower(u.email) = new.email
  on conflict (org_id, user_id) do update set role = 'guest' where public.org_members.role = 'pending';
  return null;
end $$;
create trigger link_campaign_guest after insert on public.campaign_guests
  for each row execute function public.link_campaign_guest();

create or replace function public.log_sign_in() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform public.log_user_event(new.id, new.email, 'login');
  update public.org_members set last_login_at = new.last_sign_in_at where user_id = new.id;
  return null;
exception when others then
  return null;  -- this runs inside sign-in; a log failure must never lock anyone out
end $$;

-- last_login_at changes on every sign-in, which already has its own log entry.
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
     where n.value is distinct from o.value and n.key not in ('updated_at','last_login_at');
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

create trigger log_row_change after insert or update or delete on public.admin_delegations
  for each row execute function public.log_row_change();
create trigger log_row_change after insert or update or delete on public.fundraiser_overrides
  for each row execute function public.log_row_change();
create trigger log_row_change after insert or update or delete on public.campaign_guests
  for each row execute function public.log_row_change();

-- ---------------------------------------------------------------------------
-- Campaign rules
-- ---------------------------------------------------------------------------
-- IDs are permanent and never reused. Deleted campaigns keep their row, so counting them is enough.
-- An explicit ID is still accepted, for imports that must keep existing numbers.
create or replace function public.campaign_before_write() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.id is null then
      perform pg_advisory_xact_lock(hashtext('campaign_id:' || new.org_id::text));
      select (greatest(coalesce(max(c.id::bigint), 0), 999) + 1)::text into new.id
      from public.campaigns c where c.org_id = new.org_id and c.id ~ '^\d+$';
    end if;
    new.external_name := coalesce(new.external_name, new.internal_name);
  else
    if new.id <> old.id and auth.uid() is not null then
      raise exception 'Campaign IDs are permanent';
    end if;
    if old.status = 'closed' and new.status <> 'closed' and auth.uid() is not null
       and not public.has_super_permission('reopen_campaigns') then
      raise exception 'Only the Super Admin can reopen a closed campaign';
    end if;
  end if;

  if tg_op = 'INSERT' or new.status is distinct from old.status then
    new.archived_at := case when new.status = 'archived' then coalesce(new.archived_at, now()) end;
    new.closed_at := case when new.status = 'closed' then coalesce(new.closed_at, now()) end;
  end if;
  return new;
end $$;
create trigger campaign_before_write before insert or update on public.campaigns
  for each row execute function public.campaign_before_write();

-- Money or a commitment arriving on an archived campaign brings it back. A closed one accepts
-- nothing new, though what's already on it can still be edited.
create or replace function public.campaign_activity_rules() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_status text;
  -- Through jsonb because this runs on tables that have no status column.
  v_reactivates boolean := tg_table_name = 'pledges'
    or (tg_table_name = 'donations' and to_jsonb(new) ->> 'status' in ('completed','collect'));
begin
  if new.campaign_id is null or (tg_op = 'UPDATE' and new.campaign_id is not distinct from old.campaign_id) then
    return new;
  end if;
  select c.status into v_status from public.campaigns c where c.org_id = new.org_id and c.id = new.campaign_id;
  if v_status = 'closed' then
    raise exception 'Campaign % is closed and can''t accept new activity', new.campaign_id;
  end if;
  if v_status = 'archived' and v_reactivates then
    update public.campaigns set status = 'active' where org_id = new.org_id and id = new.campaign_id;
  end if;
  return new;
end $$;
create trigger campaign_activity_rules before insert or update of campaign_id on public.donations
  for each row execute function public.campaign_activity_rules();
create trigger campaign_activity_rules before insert or update of campaign_id on public.pledges
  for each row execute function public.campaign_activity_rules();
create trigger campaign_activity_rules before insert or update of campaign_id on public.expenses
  for each row execute function public.campaign_activity_rules();

create or replace function public.transfer_rules() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.campaigns c
             where c.org_id = new.org_id and c.id in (new.from_campaign_id, new.to_campaign_id)
               and c.status in ('archived','closed')) then
    raise exception 'Transfers can''t involve an archived or closed campaign. Reactivate it first.';
  end if;
  return new;
end $$;
create trigger transfer_rules before insert on public.transfers
  for each row execute function public.transfer_rules();

-- ---------------------------------------------------------------------------
-- Views: only completed money counts. A voided or failed gift never happened; a refunded or
-- returned one did, so its fee stays spent.
-- ---------------------------------------------------------------------------
create view public.campaign_summary with (security_invoker = true) as
with d as (
  select org_id, campaign_id,
         sum(case when status <> 'completed' then 0
                  when type = 'Payment' then amount
                  else coalesce(funded, 0) end)                as donations_raised,
         sum(case when status in ('completed','collect','refunded','returned') then coalesce(fee, 0) else 0 end) as fees,
         sum(case when status in ('completed','collect') then coalesce(batch_pending, 0) else 0 end) as pending_balance,
         count(*) filter (where status in ('completed','collect','refunded','returned')) as donation_count,
         max(created_at) filter (where status <> 'failed')     as last_donation_at
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
  where donor_id is not null and status in ('completed','collect') and deleted_at is null
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
  where status in ('completed','collect') and deleted_at is null
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
  from public.donations where status in ('completed','collect') and deleted_at is null group by org_id, account_id
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
       count(c.id) filter (where c.status = 'active')  as active_count,
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
-- A guest follows a campaign through these two functions and has no access to any table, so they
-- can only ever see what the spec lists: external name, totals, and who gave what, how and when.
-- ---------------------------------------------------------------------------
create or replace function public.guest_campaigns()
returns table (id text, name text, status text, raised numeric, balance numeric)
language sql stable security definer set search_path = '' as $$
  select c.id, c.external_name, c.status, c.raised, c.balance
  from public.campaign_summary c
  where c.org_id = public.current_org_id() and c.id = any(public.my_guest_campaign_ids())
  order by c.id
$$;

create or replace function public.guest_donations(p_campaign text)
returns table (created_at timestamptz, donor text, amount numeric, payment_method text)
language sql stable security definer set search_path = '' as $$
  select d.created_at, coalesce(dn.display_name, nullif(d.name, ''), 'Anonymous'), d.amount, d.payment_method
  from public.donations d
  left join public.donors dn on dn.org_id = d.org_id and dn.id = d.donor_id and dn.deleted_at is null
  where d.org_id = public.current_org_id() and d.campaign_id = p_campaign and d.status = 'completed' and d.deleted_at is null
    and p_campaign = any(public.my_guest_campaign_ids())
  order by d.created_at desc
$$;

-- ---------------------------------------------------------------------------
-- Row-level security for the new tables
-- ---------------------------------------------------------------------------
alter table public.admin_delegations    enable row level security;
alter table public.fundraiser_overrides enable row level security;
alter table public.campaign_guests      enable row level security;

revoke all on public.admin_delegations, public.fundraiser_overrides from anon, authenticated;
grant select on public.admin_delegations, public.fundraiser_overrides to authenticated;
revoke all on public.campaign_guests from anon;

do $$
declare t text;
begin
  foreach t in array array['admin_delegations','fundraiser_overrides','campaign_guests'] loop
    execute format('create policy org_wall on public.%I as restrictive for all to authenticated
                    using (org_id = (select public.current_org_id()))
                    with check (org_id = (select public.current_org_id()))', t);
  end loop;
end $$;

create policy admin_read on public.admin_delegations for select to authenticated using ((select public.is_admin()));
create policy own_read   on public.admin_delegations for select to authenticated using (user_id = (select auth.uid()));
create policy admin_read on public.fundraiser_overrides for select to authenticated using ((select public.is_admin()));
create policy own_read   on public.fundraiser_overrides for select to authenticated
  using (manager_id = any((select public.my_manager_ids())::text[]));
create policy admin_all  on public.campaign_guests for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

-- Adding an admin email makes that person an admin, so it needs the same authority.
drop policy admin_all on public.admin_emails;
create policy admin_read on public.admin_emails for select to authenticated using ((select public.is_admin()));
create policy manage_write on public.admin_emails for insert to authenticated
  with check ((select public.has_super_permission('manage_admins')));
create policy manage_delete on public.admin_emails for delete to authenticated
  using ((select public.has_super_permission('manage_admins')));

-- ---------------------------------------------------------------------------
-- What the app needs to know
-- ---------------------------------------------------------------------------
create or replace function public.my_access() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'org_id', public.current_org_id(),
    'role', public.my_org_role(),
    'status', (select m.status from public.org_members m
               where m.user_id = auth.uid() and m.org_id = public.current_org_id()),
    'permissions', case when public.is_super_admin()
                        then '["manage_admins","grant_overrides","manage_api_keys","run_imports","change_default_bank","configure_fees","reverse_imports","reopen_campaigns"]'::jsonb
                        else (select coalesce(jsonb_agg(d.permission), '[]') from public.admin_delegations d
                              where d.user_id = auth.uid() and d.org_id = public.current_org_id()) end,
    'is_platform_owner', public.is_platform_owner(),
    'in_platform_session', coalesce(public.has_platform_session(public.current_org_id()), false),
    'orgs', (select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'slug', o.slug, 'name', o.name, 'role', m.role) order by o.name), '[]')
             from public.org_members m
             join public.organizations o on o.id = m.org_id and o.status = 'active'
             where m.user_id = auth.uid()))
$$;

-- Internal helpers: not callable over the API.
revoke execute on function public.guard_org_member()        from public, anon, authenticated;
revoke execute on function public.admin_role_for(uuid)      from public, anon, authenticated;
revoke execute on function public.link_campaign_guest()     from public, anon, authenticated;
revoke execute on function public.campaign_before_write()   from public, anon, authenticated;
revoke execute on function public.campaign_activity_rules() from public, anon, authenticated;
revoke execute on function public.transfer_rules()          from public, anon, authenticated;

-- Signed-in only; each checks the caller's rights itself.
revoke execute on function public.is_super_admin()                    from public, anon;
revoke execute on function public.has_super_permission(text)          from public, anon;
revoke execute on function public.my_guest_campaign_ids()             from public, anon;
revoke execute on function public.is_primary_on(text)                 from public, anon;
revoke execute on function public.has_override(text, text)            from public, anon;
revoke execute on function public.transfer_super_admin(uuid)          from public, anon;
revoke execute on function public.set_delegation(uuid, text, boolean) from public, anon;
revoke execute on function public.grant_override(text, text, text[])  from public, anon;
revoke execute on function public.revoke_override(text, text)         from public, anon;
revoke execute on function public.set_fundraiser_status(text, text, text) from public, anon;
revoke execute on function public.set_member_status(uuid, text, text) from public, anon;
revoke execute on function public.guest_campaigns()                   from public, anon;
revoke execute on function public.guest_donations(text)               from public, anon;
grant execute on function public.is_super_admin()                     to authenticated;
grant execute on function public.has_super_permission(text)           to authenticated;
grant execute on function public.my_guest_campaign_ids()              to authenticated;
grant execute on function public.is_primary_on(text)                  to authenticated;
grant execute on function public.has_override(text, text)             to authenticated;
grant execute on function public.transfer_super_admin(uuid)           to authenticated;
grant execute on function public.set_delegation(uuid, text, boolean)  to authenticated;
grant execute on function public.grant_override(text, text, text[])   to authenticated;
grant execute on function public.revoke_override(text, text)          to authenticated;
grant execute on function public.set_fundraiser_status(text, text, text) to authenticated;
grant execute on function public.set_member_status(uuid, text, text)  to authenticated;
grant execute on function public.guest_campaigns()                    to authenticated;
grant execute on function public.guest_donations(text)                to authenticated;

-- ---------------------------------------------------------------------------
-- Stop here if any campaign's numbers moved.
-- ---------------------------------------------------------------------------
do $$
declare v_moved int;
begin
  select count(*) into v_moved
  from _balances_before b
  full join public.campaign_summary c on c.org_id = b.org_id and c.id = b.id
  where b.raised is distinct from c.raised or b.fees is distinct from c.fees
     or b.expenses is distinct from c.expenses or b.balance is distinct from c.balance
     or b.pending_balance is distinct from c.pending_balance;
  if v_moved > 0 then
    raise exception 'Roles and statuses migration changed the balance of % campaign(s)', v_moved;
  end if;
end $$;

drop table _balances_before;
