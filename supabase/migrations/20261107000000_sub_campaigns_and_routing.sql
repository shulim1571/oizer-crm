-- Phase 4, part 3: sub-campaigns (shared or independent balance), inter-campaign transfer rules, and
-- bank account routing. Payment pages for sub-campaigns arrive in Phase 8 and bank feeds in Phase 11.
-- The migration fails at the end if any campaign's numbers changed.

create temp table _balances_before as
  select org_id, id, raised, fees, expenses, balance, pending_balance from public.campaign_summary;

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------
drop view public.manager_summary;
drop view public.campaign_summary;

alter table public.campaigns
  add column parent_campaign_id text,
  add column balance_mode text not null default 'independent' check (balance_mode in ('shared','independent')),
  add column sub_slug text,
  add column goal numeric(14,2) check (goal >= 0),
  add column account_id text,
  add constraint campaigns_parent_fkey foreign key (org_id, parent_campaign_id) references public.campaigns (org_id, id) on update cascade,
  add constraint campaigns_account_fkey foreign key (org_id, account_id) references public.accounts (org_id, id),
  add constraint campaigns_shared_needs_parent check (balance_mode = 'independent' or parent_campaign_id is not null),
  add constraint campaigns_not_own_parent check (parent_campaign_id is distinct from id);
create index campaigns_org_parent_idx on public.campaigns (org_id, parent_campaign_id);
create index campaigns_org_account_idx on public.campaigns (org_id, account_id);
create unique index campaigns_sub_slug on public.campaigns (org_id, parent_campaign_id, sub_slug) where parent_campaign_id is not null and deleted_at is null;

alter table public.payment_methods
  add column account_id text,
  add constraint payment_methods_account_fkey foreign key (org_id, account_id) references public.accounts (org_id, id);
create index payment_methods_org_account_idx on public.payment_methods (org_id, account_id);

alter table public.transfers add column cross_account boolean not null default false;

create table public.campaign_mode_changes (
  id          text not null default public.short_id(),
  org_id      uuid not null references public.organizations(id),
  campaign_id text not null,
  old_mode    text not null,
  new_mode    text not null,
  amount      numeric(14,2) not null,
  note        text not null,
  changed_by  text not null default public.current_email(),
  created_at  timestamptz not null default now(),
  primary key (org_id, id),
  foreign key (org_id, campaign_id) references public.campaigns (org_id, id) on update cascade
);
create index campaign_mode_changes_org_campaign_idx on public.campaign_mode_changes (org_id, campaign_id);

-- ---------------------------------------------------------------------------
-- Access: a fundraiser on a parent also has its sub-campaigns. One on a sub-campaign has only that.
-- ---------------------------------------------------------------------------
create or replace function public.my_campaign_ids() returns text[]
language sql stable security definer set search_path = '' as $$
  with recursive mine as (
    select c.org_id, c.id
    from public.campaigns c
    where c.org_id = public.current_org_id()
      and c.deleted_at is null
      and (c.manager_id = any(public.my_manager_ids())
           or c.sub_manager_ids && public.my_manager_ids())
    union
    select k.org_id, k.id
    from mine m
    join public.campaigns k on k.org_id = m.org_id and k.parent_campaign_id = m.id and k.deleted_at is null
  )
  select coalesce(array_agg(id), '{}') from mine
$$;

-- ---------------------------------------------------------------------------
-- Fees and bank accounts come from the nearest level that sets them.
-- ---------------------------------------------------------------------------
create or replace function public.calculate_fee(p_org uuid, p_campaign text, p_method text, p_amount numeric) returns numeric
language sql stable security definer set search_path = '' as $$
  with recursive up as (
    select c.id, c.parent_campaign_id, 0 as depth from public.campaigns c where c.org_id = p_org and c.id = p_campaign
    union all
    select c.id, c.parent_campaign_id, up.depth + 1
    from up join public.campaigns c on c.org_id = p_org and c.id = up.parent_campaign_id
  )
  select round(case r.fee_type
                 when 'flat' then r.fee_flat
                 when 'percent' then p_amount * r.fee_percent / 100
                 when 'percent_flat' then p_amount * r.fee_percent / 100 + r.fee_flat
                 else 0 end, 2)
  from (
    select coalesce(o.fee_type, m.fee_type) fee_type, coalesce(o.fee_percent, m.fee_percent) fee_percent, coalesce(o.fee_flat, m.fee_flat) fee_flat
    from public.payment_methods m
    left join lateral (
      select f.fee_type, f.fee_percent, f.fee_flat
      from public.campaign_fee_overrides f join up on up.id = f.campaign_id
      where f.org_id = m.org_id and f.method_id = m.id
      order by up.depth limit 1
    ) o on true
    where m.org_id = p_org and lower(m.name) = lower(p_method)
  ) r
$$;

create or replace function public.campaign_account(p_org uuid, p_campaign text) returns text
language sql stable security definer set search_path = '' as $$
  with recursive up as (
    select c.account_id, c.parent_campaign_id, 0 as depth from public.campaigns c where c.org_id = p_org and c.id = p_campaign
    union all
    select c.account_id, c.parent_campaign_id, up.depth + 1
    from up join public.campaigns c on c.org_id = p_org and c.id = up.parent_campaign_id
  )
  select account_id from up where account_id is not null order by depth limit 1
$$;

create or replace function public.default_account(p_org uuid) returns text
language sql stable security definer set search_path = '' as $$
  select s.value #>> '{}' from public.settings s where s.org_id = p_org and s.key = 'default_account_id'
$$;

-- Campaign (or the nearest parent that sets one), then the payment method, then the default.
create or replace function public.route_account(p_org uuid, p_campaign text, p_method text) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(
    public.campaign_account(p_org, p_campaign),
    (select m.account_id from public.payment_methods m where m.org_id = p_org and lower(m.name) = lower(p_method)),
    public.default_account(p_org))
$$;

create or replace function public.donation_defaults() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_window int;
begin
  if tg_op = 'UPDATE' then
    if (new.amount is distinct from old.amount or new.fee is distinct from old.fee)
       and new.net_donation is not distinct from old.net_donation then
      new.net_donation := new.amount - coalesce(new.fee, 0);
    end if;
    return new;
  end if;

  -- Anything a fundraiser enters waits for an admin.
  if auth.uid() is not null and not public.is_admin() then
    new.status := 'pending';
  elsif new.post_dated and new.check_date > current_date and new.status = 'completed' then
    new.status := 'post_dated';
  end if;

  if new.fee is null and new.payment_method is not null then
    new.fee := public.calculate_fee(new.org_id, new.campaign_id, new.payment_method, new.amount);
  end if;
  if new.net_donation is null then
    new.net_donation := new.amount - coalesce(new.fee, 0);
  end if;
  if new.type = 'Batch' and new.is_batch is null then
    new.is_batch := true;
  end if;
  new.account_id := coalesce(new.account_id, public.route_account(new.org_id, new.campaign_id, new.payment_method));

  -- Same donor, amount and campaign moments apart. Flags both; never blocks.
  if new.donor_id is not null and new.campaign_id is not null then
    select coalesce((s.value #>> '{}')::int, 10) into v_window
    from public.settings s where s.org_id = new.org_id and s.key = 'duplicate_window_minutes';
    update public.donations d set possible_duplicate = true
    where d.org_id = new.org_id and d.donor_id = new.donor_id and d.campaign_id = new.campaign_id and d.amount = new.amount
      and d.deleted_at is null and d.status not in ('voided','failed','rejected')
      and d.created_at between new.created_at - make_interval(mins => coalesce(v_window, 10)) and new.created_at + make_interval(mins => coalesce(v_window, 10));
    if found then new.possible_duplicate := true; end if;
  end if;
  return new;
end $$;

-- Only someone who can change the default bank account can change this setting, however it's reached.
create or replace function public.guard_default_account() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.key = 'default_account_id' and auth.uid() is not null and not public.has_super_permission('change_default_bank') then
    raise exception 'Only the Super Admin can change the default bank account';
  end if;
  return new;
end $$;
create trigger guard_default_account before insert or update on public.settings
  for each row execute function public.guard_default_account();

create or replace function public.set_default_account(p_account text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id();
begin
  if not public.has_super_permission('change_default_bank') then
    raise exception 'Only the Super Admin can change the default bank account';
  end if;
  if not exists (select 1 from public.accounts a where a.org_id = v_org and a.id = p_account and a.deleted_at is null) then
    raise exception 'Account not found';
  end if;
  insert into public.settings (org_id, key, value, description, updated_by)
  values (v_org, 'default_account_id', to_jsonb(p_account), 'Bank account payments go to unless a campaign or payment method says otherwise', public.current_email())
  on conflict (org_id, key) do update set value = excluded.value, updated_by = excluded.updated_by;
end $$;

-- ---------------------------------------------------------------------------
-- Transfers: both sides, between campaigns that have a balance. Corrected only by a reverse transfer.
-- ---------------------------------------------------------------------------
create or replace function public.transfer_rules() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.amount is null or new.amount <= 0 then
    raise exception 'A transfer needs an amount above zero';
  end if;
  if new.from_campaign_id is null or new.to_campaign_id is null then
    raise exception 'A transfer needs both a source and a destination campaign';
  end if;
  if new.from_campaign_id = new.to_campaign_id then
    raise exception 'A transfer needs two different campaigns';
  end if;
  if exists (select 1 from public.campaigns c
             where c.org_id = new.org_id and c.id in (new.from_campaign_id, new.to_campaign_id)
               and c.status in ('archived','closed')) then
    raise exception 'Transfers can''t involve an archived or closed campaign. Reactivate it first.';
  end if;
  if exists (select 1 from public.campaigns c
             where c.org_id = new.org_id and c.id in (new.from_campaign_id, new.to_campaign_id)
               and c.balance_mode = 'shared') then
    raise exception 'A shared-balance sub-campaign has no balance of its own. Use its parent.';
  end if;
  if not new.cross_account
     and coalesce(public.campaign_account(new.org_id, new.from_campaign_id), public.default_account(new.org_id))
         is distinct from coalesce(public.campaign_account(new.org_id, new.to_campaign_id), public.default_account(new.org_id)) then
    raise exception 'These campaigns are on different bank accounts. Mark this as a cross-account transfer to go ahead.';
  end if;
  return new;
end $$;

create or replace function public.transfer_lock() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.amount is distinct from old.amount or new.from_campaign_id is distinct from old.from_campaign_id
     or new.to_campaign_id is distinct from old.to_campaign_id or new.cross_account is distinct from old.cross_account
     or (new.deleted_at is not null and old.deleted_at is null) then
    raise exception 'A transfer can''t be changed or deleted. Post a reverse transfer instead.';
  end if;
  return new;
end $$;
create trigger transfer_lock before update on public.transfers
  for each row execute function public.transfer_lock();

-- Fundraisers have no view of transfers, but their balances still have to include them.
drop policy manager_read on public.transfers;

create or replace function public.campaign_transfer_totals()
returns table (org_id uuid, campaign_id text, amount_in numeric, amount_out numeric)
language sql stable security definer set search_path = '' as $$
  select x.org_id, x.campaign_id, sum(x.amount_in), sum(x.amount_out)
  from (
    select t.org_id, t.to_campaign_id as campaign_id, t.amount as amount_in, 0::numeric as amount_out
    from public.transfers t where t.deleted_at is null and t.to_campaign_id is not null
    union all
    select t.org_id, t.from_campaign_id, 0, t.amount
    from public.transfers t where t.deleted_at is null and t.from_campaign_id is not null
  ) x
  where auth.uid() is null
     or (x.org_id = public.current_org_id()
         and (public.is_admin() or x.campaign_id = any(public.my_campaign_ids()) or x.campaign_id = any(public.my_guest_campaign_ids())))
  group by x.org_id, x.campaign_id
$$;

-- ---------------------------------------------------------------------------
-- Balances. A shared sub-campaign has no balance: its money counts in the nearest ancestor that does.
-- Worked out when read, so changing a mode can't lose or double-count anything.
-- ---------------------------------------------------------------------------
create view public.campaign_summary with (security_invoker = true) as
with recursive walk as (
  select c.org_id, c.id, c.parent_campaign_id as up
  from public.campaigns c where c.balance_mode = 'shared' and c.deleted_at is null
  union all
  select w.org_id, w.id, p.parent_campaign_id
  from walk w join public.campaigns p on p.org_id = w.org_id and p.id = w.up
  where p.balance_mode = 'shared'
), pool as (
  select w.org_id, w.id, w.up as pool_id
  from walk w
  where not exists (select 1 from public.campaigns p where p.org_id = w.org_id and p.id = w.up and p.balance_mode = 'shared')
), d as (
  select org_id, campaign_id,
         sum(case when status <> 'completed' then 0
                  when type = 'Payment' then amount
                  else coalesce(funded, 0) end)                as donations_raised,
         sum(case when status in ('completed','collect','refunded','returned') then coalesce(fee, 0) else 0 end) as fees,
         sum(case when status in ('completed','collect') then coalesce(batch_pending, 0) else 0 end) as pending_balance,
         count(*) filter (where status in ('completed','collect','refunded','returned')) as donation_count,
         max(created_at) filter (where status <> 'failed')     as last_donation_at,
         sum(case when status = 'post_dated' then amount else 0 end) as post_dated_amount,
         sum(case when status = 'pending' then amount else 0 end) as awaiting_approval
  from public.donations where deleted_at is null group by org_id, campaign_id
), e as (
  select org_id, campaign_id, sum(amount) as expenses from public.expenses where deleted_at is null group by org_id, campaign_id
), t as (
  select * from public.campaign_transfer_totals()
), vf as (
  select org_id, voucher_id, sum(amount) as funded from public.donations
  where voucher_id is not null and deleted_at is null and status in ('completed','collect') group by org_id, voucher_id
), v as (
  select v.org_id, v.campaign_id, sum(greatest(v.face_value - coalesce(vf.funded, 0), 0)) as awaiting_funds
  from public.vouchers v left join vf on vf.org_id = v.org_id and vf.voucher_id = v.id
  where v.deleted_at is null and v.cancelled_at is null group by v.org_id, v.campaign_id
), pr as (
  select org_id, pledge_id, sum(amount) as received from public.pledge_payments group by org_id, pledge_id
), pl as (
  select p.org_id, p.campaign_id, sum(greatest(p.amount - coalesce(pr.received, 0), 0)) as pledged_open
  from public.pledges p left join pr on pr.org_id = p.org_id and pr.pledge_id = p.id
  where p.deleted_at is null and p.cancelled_at is null group by p.org_id, p.campaign_id
), ip as (
  select org_id, installment_id, sum(amount) as paid from public.pledge_payments where installment_id is not null group by org_id, installment_id
), sch as (
  select p.org_id, p.campaign_id,
         sum(greatest(i.amount - coalesce(ip.paid, 0), 0)) filter (where i.due_date <= current_date + 30) as next_30,
         sum(greatest(i.amount - coalesce(ip.paid, 0), 0)) as next_90
  from public.pledge_installments i
  join public.pledges p on p.org_id = i.org_id and p.id = i.pledge_id
  left join ip on ip.org_id = i.org_id and ip.installment_id = i.id
  where not i.skipped and not i.cancelled and p.deleted_at is null and p.cancelled_at is null
    and i.due_date between current_date and current_date + 90
  group by p.org_id, p.campaign_id
), own as (
  select c.*,
         m.full_name                                                  as manager_name,
         coalesce(d.donations_raised, 0) + coalesce(t.amount_in, 0)   as raised,
         coalesce(d.fees, 0)                                          as fees,
         case when coalesce(d.donations_raised, 0) + coalesce(t.amount_in, 0) = 0 then 0
              else coalesce(d.fees, 0) / (coalesce(d.donations_raised, 0) + coalesce(t.amount_in, 0)) end as fee_percent,
         coalesce(e.expenses, 0) + coalesce(t.amount_out, 0)          as expenses,
         coalesce(d.donations_raised, 0) + coalesce(t.amount_in, 0)
           - coalesce(d.fees, 0) - coalesce(e.expenses, 0) - coalesce(t.amount_out, 0) as own_balance,
         coalesce(d.pending_balance, 0)                               as pending_balance,
         coalesce(d.donation_count, 0)                                as donation_count,
         d.last_donation_at,
         coalesce(d.post_dated_amount, 0)                             as post_dated_amount,
         coalesce(d.awaiting_approval, 0)                             as awaiting_approval,
         coalesce(v.awaiting_funds, 0)                                as awaiting_funds,
         coalesce(pl.pledged_open, 0)                                 as pledged_open,
         coalesce(sch.next_30, 0)                                     as pledge_scheduled_30,
         coalesce(sch.next_90, 0)                                     as pledge_scheduled_90,
         pool.pool_id
  from public.campaigns c
  left join public.managers m on m.org_id = c.org_id and m.id = c.manager_id and m.deleted_at is null
  left join d    on d.org_id   = c.org_id and d.campaign_id   = c.id
  left join e    on e.org_id   = c.org_id and e.campaign_id   = c.id
  left join t    on t.org_id   = c.org_id and t.campaign_id   = c.id
  left join v    on v.org_id   = c.org_id and v.campaign_id   = c.id
  left join pl   on pl.org_id  = c.org_id and pl.campaign_id  = c.id
  left join sch  on sch.org_id = c.org_id and sch.campaign_id = c.id
  left join pool on pool.org_id = c.org_id and pool.id = c.id
  where c.deleted_at is null
), rollup as (
  select org_id, coalesce(pool_id, id) as id,
         sum(raised) as raised, sum(fees) as fees, sum(expenses) as expenses, sum(own_balance) as balance, sum(donation_count) as donations
  from own group by org_id, coalesce(pool_id, id)
), kids as (
  select org_id, parent_campaign_id as id, count(*) as sub_count from own where parent_campaign_id is not null group by org_id, parent_campaign_id
)
select o.*,
       case when o.pool_id is not null then 0 else r.balance end as balance,
       coalesce(r.raised, o.raised)      as combined_raised,
       coalesce(r.fees, o.fees)          as combined_fees,
       coalesce(r.expenses, o.expenses)  as combined_expenses,
       coalesce(r.donations, o.donation_count) as combined_donations,
       coalesce(k.sub_count, 0)          as sub_count
from own o
left join rollup r on r.org_id = o.org_id and r.id = o.id
left join kids k on k.org_id = o.org_id and k.id = o.id;

create view public.manager_summary with (security_invoker = true) as
select m.id, m.first_name, m.last_name, m.full_name, m.phone, m.email, m.notes, m.created_by, m.created_at, m.updated_at,
       m.deleted_at, m.deleted_by, m.org_id, m.status, m.status_reason, m.status_by, m.status_at,
       count(c.id) as campaign_count,
       count(c.id) filter (where c.status = 'active') as active_count,
       coalesce(sum(c.raised), 0) as raised,
       coalesce(sum(c.balance), 0) as balance
from public.managers m
left join public.campaign_summary c on c.org_id = m.org_id and (c.manager_id = m.id or m.id = any(c.sub_manager_ids))
where m.deleted_at is null
group by m.org_id, m.id;

revoke all on public.campaign_summary, public.manager_summary from anon;
grant select on public.campaign_summary, public.manager_summary to authenticated;

-- ---------------------------------------------------------------------------
-- The tree: how it's kept sound, and what follows a parent
-- ---------------------------------------------------------------------------
create or replace function public.campaign_tree_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.parent_campaign_id is distinct from old.parent_campaign_id then
    raise exception 'A sub-campaign can''t be moved to another parent';
  end if;
  if new.balance_mode is distinct from old.balance_mode and coalesce(current_setting('app.balance_mode_change', true), '') <> 'on' then
    raise exception 'Change the balance mode with Change balance mode, so the money is accounted for';
  end if;
  if new.deleted_at is not null and old.deleted_at is null then
    if exists (select 1 from public.campaigns c where c.org_id = new.org_id and c.parent_campaign_id = new.id and c.deleted_at is null) then
      raise exception 'This campaign has sub-campaigns. Delete those first';
    end if;
    if new.balance_mode = 'shared' and exists (select 1 from public.donations d where d.org_id = new.org_id and d.campaign_id = new.id and d.deleted_at is null) then
      raise exception 'This sub-campaign has transactions that count toward its parent. Move or delete them first';
    end if;
  end if;
  return new;
end $$;
create trigger campaign_tree_guard before update on public.campaigns
  for each row execute function public.campaign_tree_guard();

-- Archiving or closing a parent takes its sub-campaigns with it. Bringing it back doesn't.
create or replace function public.campaign_status_cascade() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'closed' then
    update public.campaigns set status = 'closed'
    where org_id = new.org_id and parent_campaign_id = new.id and status <> 'closed' and deleted_at is null;
  elsif new.status = 'archived' then
    update public.campaigns set status = 'archived'
    where org_id = new.org_id and parent_campaign_id = new.id and status in ('active','draft') and deleted_at is null;
  end if;
  return null;
end $$;
create trigger campaign_status_cascade after update of status on public.campaigns
  for each row when (new.status is distinct from old.status) execute function public.campaign_status_cascade();

-- Payouts come from whichever level holds the balance.
create or replace function public.expense_rules() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.campaign_id is not null and (tg_op = 'INSERT' or new.campaign_id is distinct from old.campaign_id)
     and exists (select 1 from public.campaigns c where c.org_id = new.org_id and c.id = new.campaign_id and c.balance_mode = 'shared') then
    raise exception 'A shared-balance sub-campaign has no balance of its own. Enter this on its parent.';
  end if;
  return new;
end $$;
create trigger expense_rules before insert or update of campaign_id on public.expenses
  for each row execute function public.expense_rules();

create or replace function public.add_sub_campaign(
  p_parent text, p_name text, p_mode text default 'shared', p_goal numeric default null, p_manager text default null
) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public.current_org_id();
  p public.campaigns;
  v_base text;
  v_slug text;
  v_n int := 1;
  v_id text;
begin
  select * into p from public.campaigns where org_id = v_org and id = p_parent and deleted_at is null;
  if p.id is null then raise exception 'Campaign not found'; end if;
  if not public.is_admin() and not public.is_primary_on(p_parent) then
    raise exception 'Only an admin or the campaign''s primary fundraiser can add a sub-campaign';
  end if;
  if p.status = 'closed' then raise exception 'Campaign % is closed and can''t accept new activity', p_parent; end if;
  if nullif(trim(p_name), '') is null then raise exception 'A sub-campaign needs a name'; end if;
  if p_mode not in ('shared','independent') then raise exception 'Choose shared or independent'; end if;
  if exists (select 1 from public.campaigns c where c.org_id = v_org and c.parent_campaign_id = p_parent and lower(c.internal_name) = lower(trim(p_name)) and c.deleted_at is null) then
    raise exception 'This campaign already has a sub-campaign with that name';
  end if;

  v_base := coalesce(nullif(trim(both '-' from regexp_replace(lower(trim(p_name)), '[^a-z0-9]+', '-', 'g')), ''), 'sub');
  v_slug := v_base;
  while exists (select 1 from public.campaigns c where c.org_id = v_org and c.parent_campaign_id = p_parent and c.sub_slug = v_slug and c.deleted_at is null) loop
    v_n := v_n + 1;
    v_slug := v_base || '-' || v_n;
  end loop;

  -- Fees and the bank account follow the parent unless the sub-campaign sets its own.
  insert into public.campaigns (org_id, internal_name, parent_campaign_id, balance_mode, sub_slug, goal, manager_id, email, phone, exchange, status)
  values (v_org, trim(p_name), p_parent, p_mode, v_slug, p_goal, p_manager, p.email, p.phone, p.exchange,
          case when p.status = 'draft' then 'draft' else 'active' end)
  returning id into v_id;
  return v_id;
end $$;

-- What moves if the mode changes: this sub-campaign and any shared ones beneath it.
create or replace function public.balance_mode_amount(p_campaign text) returns numeric
language plpgsql stable security definer set search_path = '' as $$
declare
  v_org uuid := public.current_org_id();
  v_amount numeric;
begin
  perform public.require_admin();
  with recursive tree as (
    select c.id from public.campaigns c where c.org_id = v_org and c.id = p_campaign
    union all
    select k.id from tree join public.campaigns k on k.org_id = v_org and k.parent_campaign_id = tree.id and k.balance_mode = 'shared' and k.deleted_at is null
  )
  select coalesce(sum(s.own_balance), 0) into v_amount
  from public.campaign_summary s join tree on tree.id = s.id where s.org_id = v_org;
  return v_amount;
end $$;

-- The caller confirms the amount it was shown, so the money can't have moved in between.
create or replace function public.set_balance_mode(p_campaign text, p_mode text, p_confirmed numeric) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public.current_org_id();
  c public.campaigns;
  v_amount numeric;
begin
  perform public.require_admin();
  select * into c from public.campaigns where org_id = v_org and id = p_campaign and deleted_at is null for update;
  if c.id is null then raise exception 'Campaign not found'; end if;
  if c.parent_campaign_id is null then raise exception 'Only a sub-campaign has a balance mode'; end if;
  if p_mode not in ('shared','independent') then raise exception 'Choose shared or independent'; end if;
  if c.balance_mode = p_mode then raise exception 'It already uses that mode'; end if;
  v_amount := public.balance_mode_amount(p_campaign);
  if p_confirmed is distinct from v_amount then
    raise exception 'The balance is now %. Check it and confirm again', v_amount;
  end if;

  perform set_config('app.balance_mode_change', 'on', true);
  update public.campaigns set balance_mode = p_mode where org_id = v_org and id = p_campaign;
  perform set_config('app.balance_mode_change', 'off', true);

  insert into public.campaign_mode_changes (org_id, campaign_id, old_mode, new_mode, amount, note)
  values (v_org, p_campaign, c.balance_mode, p_mode, v_amount,
          case when p_mode = 'shared' then 'Absorbed into parent on mode change' else 'Starting balance on mode change' end);
end $$;

-- ---------------------------------------------------------------------------
-- Row-level security and function access
-- ---------------------------------------------------------------------------
alter table public.campaign_mode_changes enable row level security;
revoke all on public.campaign_mode_changes from anon;
revoke insert, update, delete on public.campaign_mode_changes from authenticated;
create policy org_wall on public.campaign_mode_changes as restrictive for all to authenticated
  using (org_id = (select public.current_org_id())) with check (org_id = (select public.current_org_id()));
create policy admin_read on public.campaign_mode_changes for select to authenticated using ((select public.is_admin()));
create policy manager_read on public.campaign_mode_changes for select to authenticated
  using (campaign_id = any((select public.my_campaign_ids())::text[]));
create trigger log_row_change after insert on public.campaign_mode_changes
  for each row execute function public.log_row_change();

revoke execute on function public.campaign_account(uuid, text) from public, anon, authenticated;
revoke execute on function public.default_account(uuid) from public, anon, authenticated;
revoke execute on function public.route_account(uuid, text, text) from public, anon, authenticated;
revoke execute on function public.guard_default_account() from public, anon, authenticated;
revoke execute on function public.transfer_rules() from public, anon, authenticated;
revoke execute on function public.transfer_lock() from public, anon, authenticated;
revoke execute on function public.campaign_tree_guard() from public, anon, authenticated;
revoke execute on function public.campaign_status_cascade() from public, anon, authenticated;
revoke execute on function public.expense_rules() from public, anon, authenticated;
revoke execute on function public.set_default_account(text) from public, anon;
revoke execute on function public.campaign_transfer_totals() from public, anon;
revoke execute on function public.add_sub_campaign(text, text, text, numeric, text) from public, anon;
revoke execute on function public.balance_mode_amount(text) from public, anon;
revoke execute on function public.set_balance_mode(text, text, numeric) from public, anon;
grant execute on function public.set_default_account(text) to authenticated;
grant execute on function public.campaign_transfer_totals() to authenticated;
grant execute on function public.add_sub_campaign(text, text, text, numeric, text) to authenticated;
grant execute on function public.balance_mode_amount(text) to authenticated;
grant execute on function public.set_balance_mode(text, text, numeric) to authenticated;

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
    raise exception 'Sub-campaign migration changed the balance of % campaign(s)', v_moved;
  end if;
end $$;

drop table _balances_before;
