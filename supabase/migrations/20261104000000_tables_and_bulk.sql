-- Phase 3: saved table views, a filterable transaction list with totals, and bulk actions.

-- ---------------------------------------------------------------------------
-- Each person's own table layouts. Nobody else ever sees them.
-- ---------------------------------------------------------------------------
create table public.saved_views (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null default public.current_org_id() references public.organizations(id),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  table_key  text not null,
  name       text not null check (length(trim(name)) > 0),
  config     jsonb not null default '{}',
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  unique (org_id, user_id, table_key, name)
);
create unique index saved_views_one_default on public.saved_views (org_id, user_id, table_key) where is_default;

alter table public.saved_views enable row level security;
revoke all on public.saved_views from anon;
create policy org_wall on public.saved_views as restrictive for all to authenticated
  using (org_id = (select public.current_org_id()))
  with check (org_id = (select public.current_org_id()));
create policy own_all on public.saved_views for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- Every donation with its related names as plain columns, so any of them can be filtered and
-- sorted on the server. Security invoker: each person sees only what they already could.
-- ---------------------------------------------------------------------------
create view public.transaction_list with (security_invoker = true) as
select d.*,
       c.internal_name as campaign_internal,
       c.external_name as campaign_external,
       coalesce(dn.display_name, nullif(trim(d.donor_label), ''), d.name) as donor_name,
       coalesce(co.full_name, d.collector_label) as collector_name,
       s.name as source_name,
       a.name as account_name
from public.donations d
left join public.campaigns  c  on c.org_id  = d.org_id and c.id  = d.campaign_id
left join public.donors     dn on dn.org_id = d.org_id and dn.id = d.donor_id
left join public.collectors co on co.org_id = d.org_id and co.id = d.collector_id
left join public.sources    s  on s.org_id  = d.org_id and s.id  = d.source
left join public.accounts   a  on a.org_id  = d.org_id and a.id  = d.account_id
where d.deleted_at is null;

revoke all on public.transaction_list from anon;
grant select on public.transaction_list to authenticated;

-- Lets the app ask for totals of whatever is filtered. Row-level security still applies to them.
alter role authenticator set pgrst.db_aggregates_enabled = 'true';
notify pgrst, 'reload config';

-- ---------------------------------------------------------------------------
-- Net follows the amount and fee when either is edited, unless net itself was edited too.
-- ---------------------------------------------------------------------------
create or replace function public.donation_defaults() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    if (new.amount is distinct from old.amount or new.fee is distinct from old.fee)
       and new.net_donation is not distinct from old.net_donation then
      new.net_donation := new.amount - coalesce(new.fee, 0);
    end if;
    return new;
  end if;
  if new.net_donation is null then
    new.net_donation := new.amount - coalesce(new.fee, 0);
  end if;
  if new.type = 'Batch' and new.is_batch is null then
    new.is_batch := true;
  end if;
  return new;
end $$;

drop trigger donation_defaults on public.donations;
create trigger donation_defaults before insert or update on public.donations
  for each row execute function public.donation_defaults();

-- ---------------------------------------------------------------------------
-- Bulk actions. One statement each, so they fully happen or not at all, and the existing triggers
-- give every record its own log entry and enforce the campaign rules.
-- ---------------------------------------------------------------------------
create or replace function public.bulk_update_donations(p_ids text[], p_patch jsonb) returns integer
language plpgsql set search_path = '' as $$
declare
  v_count int;
  v_bad text;
begin
  if not public.is_admin() then
    raise exception 'Only admins can bulk edit transactions';
  end if;
  select k into v_bad from jsonb_object_keys(p_patch) k
  where k not in ('campaign_id','donor_id','collector_id','account_id','source','payment_method',
                  'type','status','amount','fee','notes','created_at')
  limit 1;
  if v_bad is not null then
    raise exception 'Can''t bulk edit %', v_bad;
  end if;

  update public.donations d set
    campaign_id    = case when p_patch ? 'campaign_id'    then p_patch ->> 'campaign_id'    else d.campaign_id end,
    donor_id       = case when p_patch ? 'donor_id'       then p_patch ->> 'donor_id'       else d.donor_id end,
    collector_id   = case when p_patch ? 'collector_id'   then p_patch ->> 'collector_id'   else d.collector_id end,
    account_id     = case when p_patch ? 'account_id'     then p_patch ->> 'account_id'     else d.account_id end,
    source         = case when p_patch ? 'source'         then p_patch ->> 'source'         else d.source end,
    payment_method = case when p_patch ? 'payment_method' then p_patch ->> 'payment_method' else d.payment_method end,
    type           = case when p_patch ? 'type'           then p_patch ->> 'type'           else d.type end,
    status         = case when p_patch ? 'status'         then p_patch ->> 'status'         else d.status end,
    amount         = case when p_patch ? 'amount'         then (p_patch ->> 'amount')::numeric else d.amount end,
    fee            = case when p_patch ? 'fee'            then (p_patch ->> 'fee')::numeric else d.fee end,
    notes          = case when p_patch ? 'notes'          then p_patch ->> 'notes'          else d.notes end,
    created_at     = case when p_patch ? 'created_at'     then (p_patch ->> 'created_at')::timestamptz else d.created_at end
  where d.id = any(p_ids) and d.org_id = public.current_org_id();
  get diagnostics v_count = row_count;
  return v_count;
end $$;

create or replace function public.bulk_delete_donations(p_ids text[]) returns integer
language plpgsql set search_path = '' as $$
declare v_count int;
begin
  if not public.is_admin() then
    raise exception 'Only admins can bulk delete transactions';
  end if;
  -- The soft-delete trigger cancels the real delete, so count what's about to be hidden.
  select count(*) into v_count from public.donations d
  where d.id = any(p_ids) and d.org_id = public.current_org_id() and d.deleted_at is null;
  delete from public.donations d where d.id = any(p_ids) and d.org_id = public.current_org_id();
  return v_count;
end $$;

revoke execute on function public.bulk_update_donations(text[], jsonb) from public, anon;
revoke execute on function public.bulk_delete_donations(text[]) from public, anon;
grant execute on function public.bulk_update_donations(text[], jsonb) to authenticated;
grant execute on function public.bulk_delete_donations(text[]) to authenticated;

-- ---------------------------------------------------------------------------
-- Indexes that match the two-part links between records.
-- ---------------------------------------------------------------------------
drop index if exists public.donations_campaign_id_idx;
drop index if exists public.donations_donor_id_idx;
drop index if exists public.donations_account_id_idx;
drop index if exists public.donations_collector_id_idx;
drop index if exists public.donations_source_idx;
drop index if exists public.expenses_campaign_id_idx;
drop index if exists public.expenses_account_id_idx;
drop index if exists public.pledges_campaign_id_idx;
drop index if exists public.pledges_donor_id_idx;
drop index if exists public.tasks_campaign_id_idx;
drop index if exists public.tasks_donor_id_idx;
drop index if exists public.transfers_from_campaign_id_idx;
drop index if exists public.transfers_to_campaign_id_idx;
drop index if exists public.campaigns_manager_id_idx;
drop index if exists public.user_managers_manager_id_idx;

create index donations_org_campaign_idx  on public.donations (org_id, campaign_id);
create index donations_org_donor_idx     on public.donations (org_id, donor_id);
create index donations_org_account_idx   on public.donations (org_id, account_id);
create index donations_org_collector_idx on public.donations (org_id, collector_id);
create index donations_org_source_idx    on public.donations (org_id, source);
create index expenses_org_campaign_idx   on public.expenses (org_id, campaign_id);
create index expenses_org_account_idx    on public.expenses (org_id, account_id);
create index pledges_org_campaign_idx    on public.pledges (org_id, campaign_id);
create index pledges_org_donor_idx       on public.pledges (org_id, donor_id);
create index tasks_org_campaign_idx      on public.tasks (org_id, campaign_id);
create index tasks_org_donor_idx         on public.tasks (org_id, donor_id);
create index transfers_org_from_idx      on public.transfers (org_id, from_campaign_id);
create index transfers_org_to_idx        on public.transfers (org_id, to_campaign_id);
create index campaigns_org_manager_idx   on public.campaigns (org_id, manager_id);
create index user_managers_org_manager_idx on public.user_managers (org_id, manager_id);
create index admin_delegations_user_idx  on public.admin_delegations (user_id);
create index platform_sessions_org_idx   on public.platform_sessions (org_id);
